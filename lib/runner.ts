"use client";

import { useStore } from "./store";
import {
  Attachment,
  contextChain,
  dependenciesOf,
  graphAtPath,
  hasRunnableWork,
  isTicketDone,
  satisfiesDependents,
  Ticket,
  ticketAtPath,
} from "./types";

const controllers = new Map<string, AbortController>();
const activeGraphRuns = new Set<string>(); // graph paths currently auto-running
const loopRunning = new Set<string>(); // prevents duplicate scheduler loops
// Tickets the user stopped: an active parent scheduler must not immediately
// restart them (their aborted work settles back to todo, which would
// otherwise look runnable again). Cleared by running the ticket again or by
// a fresh graph run at its level.
const userStopped = new Set<string>();

const pathKey = (path: string[]) => path.join("/") || "(root)";
const ticketKey = (path: string[], id: string) => pathKey(path) + "#" + id;

/** All context files that apply to a ticket: project + ancestors + its own. */
function inheritedAttachments(path: string[], ticket: Ticket): Attachment[] {
  const { project } = useStore.getState();
  return [
    ...contextChain(project, path).flatMap((l) => l.attachments),
    ...(ticket.attachments ?? []),
  ];
}

function buildPrompt(path: string[], ticket: Ticket): string {
  const { project } = useStore.getState();
  const g = graphAtPath(project.graph, path)!;
  const deps = dependenciesOf(g, ticket.id).filter(satisfiesDependents);
  const pendingReviewDeps = deps.filter((d) => !isTicketDone(d));
  const ctx = contextChain(project, path);
  const crumb = ctx.slice(1).map((l) => l.title);
  const parentContext = ctx.slice(1).filter((l) => l.description);
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

  const lines = [
    `You are an autonomous engineer working on the project "${project.name}" inside the current working directory. Do the work described by the ticket below directly in this directory.`,
    project.description && `\nProject description:\n${project.description}`,
    crumb.length > 0 && `\nThis ticket is a subtask of: ${crumb.join(" > ")}`,
    parentContext.length > 0 &&
      `\nContext from parent tickets (applies to this ticket too):\n` +
        parentContext.map((l) => `- ${l.title}: ${l.description}`).join("\n"),
    deps.length > 0 &&
      `\nCompleted tickets this one depends on:\n` +
        deps
          .map(
            (d) =>
              `- ${d.title}${isTicketDone(d) ? "" : " (finished, but still under human review — it may receive fixes)"}: ${d.resultSummary ?? "(done)"}`
          )
          .join("\n"),
    `\n## Ticket: ${ticket.title}\n${ticket.description || "(no further description)"}`,
    pendingReviewDeps.length > 0 &&
      `\nIMPORTANT — git branching: work you depend on is still under human review on the current branch. If the workspace is a git repository, create and switch to a new branch "autojira/${slug}" off the current state BEFORE making any changes, so review fixes can land on the previous branch independently. Mention the branch you worked on in your final summary.`,
    ticket.type === "human_review"
      ? `\nA human will review this ticket when you finish. If the workspace is a git repository, commit your work when done (one commit, message = ticket title) and mention the branch name in your summary. End your reply with (1) a 2-4 sentence summary of what you did and (2) a short checklist of what the human should test.`
      : `\nWork autonomously without asking questions. If the workspace is a git repository, commit your work when done (one commit, message = ticket title). End your reply with a 2-4 sentence summary of what you did, so dependent tickets can build on it.`,
  ];
  return lines.filter(Boolean).join("\n");
}

async function streamAgent(
  path: string[],
  ticketId: string,
  body: {
    prompt: string;
    sessionId?: string;
    attachments?: { name: string; dataUrl: string }[];
  }
): Promise<{ ok: boolean; text: string; sessionId?: string; aborted: boolean }> {
  const { project, appendLog, updateTicket } = useStore.getState();
  const ctrl = new AbortController();
  controllers.set(ticketKey(path, ticketId), ctrl);

  let ok = false;
  let finalText = "";
  let sessionId: string | undefined;

  try {
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, workspaceDir: project.workspaceDir }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Agent request failed (${res.status}): ${await res.text()}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "init") {
          sessionId = ev.sessionId;
          updateTicket(path, ticketId, (t) => ({ ...t, sessionId: ev.sessionId }));
        } else if (ev.type === "text") {
          appendLog(path, ticketId, { kind: "text", text: ev.text, ts: Date.now() });
        } else if (ev.type === "tool") {
          appendLog(path, ticketId, { kind: "tool", text: ev.text, ts: Date.now() });
        } else if (ev.type === "result") {
          ok = ev.ok;
          finalText = ev.text ?? "";
        } else if (ev.type === "error") {
          ok = false;
          finalText = ev.message;
          appendLog(path, ticketId, { kind: "error", text: ev.message, ts: Date.now() });
        }
      }
    }
  } catch (err) {
    ok = false;
    // A user stop is not a failure: log it as info, not error.
    finalText = ctrl.signal.aborted ? "Stopped by user" : String(err);
    appendLog(path, ticketId, {
      kind: ctrl.signal.aborted ? "info" : "error",
      text: finalText,
      ts: Date.now(),
    });
  } finally {
    controllers.delete(ticketKey(path, ticketId));
  }
  return { ok, text: finalText, sessionId, aborted: ctrl.signal.aborted };
}

/** Run one leaf ticket (no subgraph) with the agent. */
async function runLeafTicket(path: string[], ticketId: string): Promise<void> {
  const { project, updateTicket, appendLog } = useStore.getState();
  const ticket = ticketAtPath(project.graph, path, ticketId);
  if (!ticket || ticket.status === "running") return;

  updateTicket(path, ticketId, (t) => ({ ...t, status: "running" }));
  appendLog(path, ticketId, { kind: "info", text: "Run started", ts: Date.now() });

  const { ok, text, aborted } = await streamAgent(path, ticketId, {
    prompt: buildPrompt(path, ticket),
    attachments: inheritedAttachments(path, ticket).map(({ name, dataUrl }) => ({
      name,
      dataUrl,
    })),
  });

  const summary = text.length > 1500 ? text.slice(0, 1500) + "…" : text;
  // Skip the final write if something else already moved the ticket out of
  // "running" (e.g. a board rejection reset it to todo while aborting).
  // A user stop is not a failure: the ticket goes back to todo, and "error"
  // stays reserved for runs where the agent actually failed.
  updateTicket(path, ticketId, (t) =>
    t.status !== "running"
      ? t
      : aborted
        ? { ...t, status: "todo" }
        : {
            ...t,
            status: !ok ? "error" : t.type === "human_review" ? "review" : "done",
            resultSummary: summary,
          }
  );
}

/** Send human feedback into the ticket's existing agent session. */
export async function sendFeedback(
  path: string[],
  ticketId: string,
  message: string
): Promise<void> {
  const { project, updateTicket, appendLog } = useStore.getState();
  const ticket = ticketAtPath(project.graph, path, ticketId);
  if (!ticket) return;

  appendLog(path, ticketId, { kind: "user", text: message, ts: Date.now() });
  updateTicket(path, ticketId, (t) => ({ ...t, status: "running" }));

  const { ok, text, aborted } = await streamAgent(path, ticketId, {
    // With no session the ticket never ran, so this is the human opening the
    // work rather than reacting to it.
    prompt: ticket.sessionId
      ? `Human review feedback on your work for this ticket:\n\n${message}\n\nAddress the feedback, then end with a short summary of what you changed.`
      : `${buildPrompt(path, ticket)}\n\nThe human is starting this ticket with a request:\n\n${message}`,
    sessionId: ticket.sessionId,
  });

  // Stopped feedback is not a failure: the earlier work still awaits review.
  updateTicket(path, ticketId, (t) =>
    t.status !== "running"
      ? t
      : aborted
        ? { ...t, status: "review" }
        : {
            ...t,
            status: ok ? "review" : "error",
            resultSummary: text.length > 1500 ? text.slice(0, 1500) + "…" : text,
          }
  );
}

/**
 * Reject a ticket in review with feedback (kanban board's red cross): the
 * feedback resumes the ticket's agent session, and every downstream ticket
 * that already started on top of the rejected work (running or in review)
 * is reset to todo so it re-runs once the dependency is solved again.
 */
export async function rejectTicket(
  path: string[],
  ticketId: string,
  message: string
): Promise<void> {
  const { project, updateTicket } = useStore.getState();
  const g = graphAtPath(project.graph, path);
  if (!g) return;

  const downstream = new Set<string>();
  const stack = [ticketId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of g.edges) {
      if (e.source === cur && !downstream.has(e.target)) {
        downstream.add(e.target);
        stack.push(e.target);
      }
    }
  }
  for (const id of downstream) {
    const t = g.tickets.find((t) => t.id === id);
    if (t && (t.status === "running" || t.status === "review")) {
      // todo first: the aborted run's final write then sees a non-running
      // status and leaves the reset in place.
      updateTicket(path, id, (x) => ({ ...x, status: "todo" }));
      abortRun(path, id);
    }
  }

  await sendFeedback(path, ticketId, message);
  // A fixed non-blocking review satisfies dependents again — restart the
  // scheduler if this graph's run is still active.
  if (activeGraphRuns.has(pathKey(path))) void runGraph(path);
}

/** Approve a ticket in review (or force-complete any ticket). */
export function approveTicket(path: string[], ticketId: string): void {
  useStore.getState().updateTicket(path, ticketId, (t) => ({ ...t, status: "done" }));
  // If a graph run was waiting on this review, let it continue.
  if (activeGraphRuns.has(pathKey(path))) void runGraph(path);
}

/** Run a ticket: leaf tickets go to the agent, tickets with a subgraph run the subgraph. */
export async function runTicket(path: string[], ticketId: string): Promise<void> {
  userStopped.delete(ticketKey(path, ticketId));
  const { project, updateTicket } = useStore.getState();
  const ticket = ticketAtPath(project.graph, path, ticketId);
  if (!ticket) return;

  if (ticket.subgraph.tickets.length > 0) {
    updateTicket(path, ticketId, (t) => ({ ...t, status: "running" }));
    await runGraph([...path, ticketId]);
    updateTicket(path, ticketId, (t) => ({
      ...t,
      status: t.subgraph.tickets.every(isTicketDone) ? "done" : "todo",
    }));
  } else {
    await runLeafTicket(path, ticketId);
  }
}

/**
 * Run every ticket in the graph at `path`, respecting dependency edges.
 * All ready tickets run in parallel, each in its own agent session; whenever
 * one finishes, newly-unblocked tickets are started. Stops branches at
 * human-review tickets until they are approved; approving resumes the run
 * automatically.
 */
export async function runGraph(path: string[]): Promise<void> {
  const k = pathKey(path);
  // A fresh run at this level (not a resume of an active one) lifts the
  // user-stopped skip from this level's tickets.
  if (!activeGraphRuns.has(k))
    for (const key of [...userStopped])
      if (key.startsWith(k + "#")) userStopped.delete(key);
  activeGraphRuns.add(k);
  if (loopRunning.has(k)) return; // a scheduler loop is already draining this graph
  loopRunning.add(k);

  const inFlight = new Map<string, Promise<void>>(); // ticket ids currently running

  try {
    for (;;) {
      // Start everything currently ready (unless the user stopped the run).
      if (activeGraphRuns.has(k)) {
        const g = graphAtPath(useStore.getState().project.graph, path);
        if (!g) break;
        const ready = g.tickets.filter((t) => {
          if (inFlight.has(t.id) || isTicketDone(t)) return false;
          if (userStopped.has(ticketKey(path, t.id))) return false;
          if (!dependenciesOf(g, t.id).every(satisfiesDependents)) return false;
          // Parents are ready only while something inside can actually progress.
          if (t.subgraph.tickets.length > 0) return hasRunnableWork(t.subgraph);
          return t.status === "todo";
        });
        for (const t of ready) {
          inFlight.set(
            t.id,
            runTicket(path, t.id)
              .catch((err) =>
                useStore.getState().appendLog(path, t.id, {
                  kind: "error",
                  text: String(err),
                  ts: Date.now(),
                })
              )
              .finally(() => inFlight.delete(t.id))
          );
        }
      }
      if (inFlight.size === 0) break;
      // Wake when any ticket finishes, then recompute the ready set.
      await Promise.race(inFlight.values());
    }
  } finally {
    loopRunning.delete(k);
    const g = graphAtPath(useStore.getState().project.graph, path);
    // Keep the run flag only while reviews are pending (at any depth), so
    // approval resumes the run.
    const anyReview = (g2: { tickets: Ticket[] }): boolean =>
      g2.tickets.some((t) => t.status === "review" || anyReview(t.subgraph));
    if (!g || !anyReview(g)) activeGraphRuns.delete(k);

    // If this subgraph just fully completed, mark its parent ticket done and
    // let a paused parent run continue past it.
    const allDone = !!g && g.tickets.length > 0 && g.tickets.every(isTicketDone);
    if (allDone && path.length > 0) {
      const parentPath = path.slice(0, -1);
      useStore
        .getState()
        .updateTicket(parentPath, path[path.length - 1], (t) => ({
          ...t,
          status: "done",
        }));
      if (activeGraphRuns.has(pathKey(parentPath))) void runGraph(parentPath);
    }
  }
}

/** True while an actual agent request is open at or beneath this ticket. */
function liveBeneath(path: string[], t: Ticket): boolean {
  if (controllers.has(ticketKey(path, t.id))) return true;
  return t.subgraph.tickets.some((c) => liveBeneath([...path, t.id], c));
}

/** A zombie "running" — a persisted status whose browser-side run died with a
 * reload — has nothing to abort and nothing that will ever write a final
 * status, so settle it back to todo. Live runs settle themselves after the
 * abort (and must not be reset here: a todo leaf would make the parent's
 * scheduler consider it runnable again and restart it). */
function settleZombie(path: string[], ticketId: string): void {
  const t = ticketAtPath(useStore.getState().project.graph, path, ticketId);
  if (t && t.status === "running" && !liveBeneath(path, t))
    useStore.getState().updateTicket(path, ticketId, (x) => ({ ...x, status: "todo" }));
}

/** Abort a ticket's run (and its subgraph's) without marking it user-stopped;
 * rejectTicket uses this so the rejected work is free to re-run right away. */
function abortRun(path: string[], ticketId: string): void {
  controllers.get(ticketKey(path, ticketId))?.abort();
  const t = ticketAtPath(useStore.getState().project.graph, path, ticketId);
  // A ticket with a subgraph runs as a graph run underneath, not a controller.
  if (t && t.subgraph.tickets.length > 0) stopGraph([...path, ticketId]);
  settleZombie(path, ticketId);
}

export function stopTicket(path: string[], ticketId: string): void {
  userStopped.add(ticketKey(path, ticketId));
  abortRun(path, ticketId);
}

export function stopGraph(path: string[]): void {
  activeGraphRuns.delete(pathKey(path));
  const g = graphAtPath(useStore.getState().project.graph, path);
  for (const t of g?.tickets ?? []) {
    controllers.get(ticketKey(path, t.id))?.abort();
    if (t.subgraph.tickets.length > 0) stopGraph([...path, t.id]);
    settleZombie(path, t.id);
  }
}

export function isGraphRunning(path: string[]): boolean {
  return activeGraphRuns.has(pathKey(path));
}
