import {
  Attachment,
  contextChain,
  dependenciesOf,
  graphAtPath,
  hasRunnableWork,
  isTicketDone,
  Project,
  satisfiesDependents,
  Ticket,
  ticketAtPath,
} from "../types";
import { streamAgent } from "./agent";
import * as store from "./project-store";

/**
 * The run registry: agent runs execute here, in the server process, so they
 * outlive the browser tab that started them. It is the same bookkeeping the
 * browser used to keep, keyed the same way and additionally scoped by project
 * directory. It does not survive a server restart — a fresh process settles
 * whatever project.json still says is running (see settleZombies).
 */
interface Registry {
  /** Live agent sessions, by ticket key. */
  controllers: Map<string, AbortController>;
  /** Graph runs that want to continue: draining now, or parked on a human gate. */
  active: Set<string>;
  /** Scheduler loops actually draining work. */
  loops: Set<string>;
  /** Tickets the user stopped; a parent scheduler must not restart them. */
  userStopped: Set<string>;
}

const globals = globalThis as unknown as { __autojiraRegistry?: Registry };
const registry: Registry = (globals.__autojiraRegistry ??= {
  controllers: new Map(),
  active: new Set(),
  loops: new Set(),
  userStopped: new Set(),
});

const pathKey = (path: string[]) => path.join("/") || "(root)";
const ticketKey = (path: string[], id: string) => pathKey(path) + "#" + id;
const scoped = (dir: string, key: string) => dir + "\u0000" + key;
const graphScope = (dir: string, path: string[]) => scoped(dir, pathKey(path));
const ticketScope = (dir: string, path: string[], id: string) =>
  scoped(dir, ticketKey(path, id));

export interface RunState {
  /** pathKeys whose scheduler loop is draining work. */
  loops: string[];
  /** pathKeys of runs that want to continue (including parked on a gate). */
  active: string[];
  /** ticketKeys with a live agent session. */
  tickets: string[];
}

function strip(set: Set<string>, dir: string): string[] {
  const prefix = dir + "\u0000";
  return [...set].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

export function runState(dir: string): RunState {
  return {
    loops: strip(registry.loops, dir),
    active: strip(registry.active, dir),
    tickets: strip(new Set(registry.controllers.keys()), dir),
  };
}

function notifyRuns(dir: string): void {
  store.publish(dir, { type: "runs" });
}

/** Load a project into the server store, settling orphans on a cold load. */
export function ensureLoaded(dir: string): Project | null {
  const cold = !store.isLoaded(dir);
  const project = store.getProject(dir);
  // A "running" left in project.json by a process that is gone has nothing to
  // abort and nothing that will ever finish it.
  if (project && cold) settleZombies(dir);
  return store.getProject(dir);
}

// ---- prompt building (unchanged from the browser runner) ------------------

function inheritedAttachments(
  project: Project,
  path: string[],
  ticket: Ticket
): Attachment[] {
  return [
    ...contextChain(project, path).flatMap((l) => l.attachments),
    ...(ticket.attachments ?? []),
  ];
}

function buildPrompt(project: Project, path: string[], ticket: Ticket): string {
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

// ---- one agent session ----------------------------------------------------

async function runAgentSession(
  dir: string,
  path: string[],
  ticketId: string,
  body: { prompt: string; sessionId?: string; attachments?: Attachment[] }
): Promise<{ ok: boolean; text: string; aborted: boolean }> {
  const key = ticketScope(dir, path, ticketId);
  const ctrl = new AbortController();
  registry.controllers.set(key, ctrl);
  notifyRuns(dir);

  let ok = false;
  let finalText = "";

  try {
    const events = streamAgent({
      workspaceDir: store.getProject(dir)?.workspaceDir,
      prompt: body.prompt,
      sessionId: body.sessionId,
      attachments: body.attachments?.map(({ name, dataUrl }) => ({ name, dataUrl })),
      signal: ctrl.signal,
    });
    for await (const ev of events) {
      if (ev.type === "init") {
        store.updateTicket(dir, path, ticketId, (t) => ({ ...t, sessionId: ev.sessionId }));
      } else if (ev.type === "text") {
        store.appendLog(dir, path, ticketId, { kind: "text", text: ev.text, ts: Date.now() });
      } else if (ev.type === "tool") {
        store.appendLog(dir, path, ticketId, { kind: "tool", text: ev.text, ts: Date.now() });
      } else if (ev.type === "result") {
        ok = ev.ok;
        finalText = ev.text ?? "";
      } else if (ev.type === "error") {
        ok = false;
        finalText = ev.message;
        store.appendLog(dir, path, ticketId, {
          kind: "error",
          text: ev.message,
          ts: Date.now(),
        });
      }
    }
    if (ctrl.signal.aborted) {
      ok = false;
      finalText = "Stopped by user";
      store.appendLog(dir, path, ticketId, {
        kind: "info",
        text: finalText,
        ts: Date.now(),
      });
    }
  } catch (err) {
    ok = false;
    // A user stop is not a failure: log it as info, not error.
    finalText = ctrl.signal.aborted ? "Stopped by user" : String(err);
    store.appendLog(dir, path, ticketId, {
      kind: ctrl.signal.aborted ? "info" : "error",
      text: finalText,
      ts: Date.now(),
    });
  } finally {
    registry.controllers.delete(key);
    notifyRuns(dir);
  }
  return { ok, text: finalText, aborted: ctrl.signal.aborted };
}

/** True when the graph at `path` is a human ticket's kanban board. Its tickets
 * are cards the human asked for, so they are ordinary agent work even though
 * they carry type "human_review" (which is what puts them in the board's
 * "Ready for review" column, with the ✓/✕, once the agent is done). Only a
 * human ticket that is *not* a card is a gate. */
function isBoard(dir: string, path: string[]): boolean {
  if (path.length === 0) return false;
  const project = store.getProject(dir);
  const parent =
    project && ticketAtPath(project.graph, path.slice(0, -1), path[path.length - 1]);
  return parent?.type === "human_review";
}

/** Run one leaf ticket (no subgraph) with the agent. */
async function runLeafTicket(dir: string, path: string[], ticketId: string): Promise<void> {
  const project = store.getProject(dir);
  if (!project) return;
  const ticket = ticketAtPath(project.graph, path, ticketId);
  if (!ticket || ticket.status === "running") return;

  store.updateTicket(dir, path, ticketId, (t) => ({ ...t, status: "running" }));
  store.appendLog(dir, path, ticketId, { kind: "info", text: "Run started", ts: Date.now() });

  const { ok, text, aborted } = await runAgentSession(dir, path, ticketId, {
    prompt: buildPrompt(project, path, ticket),
    attachments: inheritedAttachments(project, path, ticket),
  });

  const summary = text.length > 1500 ? text.slice(0, 1500) + "…" : text;
  // Skip the final write if something else already moved the ticket out of
  // "running" (e.g. a board rejection reset it to todo while aborting).
  // A user stop is not a failure: the ticket goes back to todo, and "error"
  // stays reserved for runs where the agent actually failed.
  store.updateTicket(dir, path, ticketId, (t) =>
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
  dir: string,
  path: string[],
  ticketId: string,
  message: string
): Promise<void> {
  const project = store.getProject(dir);
  if (!project) return;
  const ticket = ticketAtPath(project.graph, path, ticketId);
  if (!ticket) return;

  store.appendLog(dir, path, ticketId, { kind: "user", text: message, ts: Date.now() });
  store.updateTicket(dir, path, ticketId, (t) => ({ ...t, status: "running" }));

  const { ok, text, aborted } = await runAgentSession(dir, path, ticketId, {
    // With no session the ticket never ran, so this is the human opening the
    // work rather than reacting to it.
    prompt: ticket.sessionId
      ? `Human review feedback on your work for this ticket:\n\n${message}\n\nAddress the feedback, then end with a short summary of what you changed.`
      : `${buildPrompt(project, path, ticket)}\n\nThe human is starting this ticket with a request:\n\n${message}`,
    sessionId: ticket.sessionId,
  });

  // Stopped feedback is not a failure: the earlier work still awaits review.
  store.updateTicket(dir, path, ticketId, (t) =>
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
  dir: string,
  path: string[],
  ticketId: string,
  message: string
): Promise<void> {
  const project = store.getProject(dir);
  const g = project && graphAtPath(project.graph, path);
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
      store.updateTicket(dir, path, id, (x) => ({ ...x, status: "todo" }));
      abortRun(dir, path, id);
    }
  }

  await sendFeedback(dir, path, ticketId, message);
  // A fixed non-blocking review satisfies dependents again — restart the
  // scheduler if this graph's run is still active.
  if (registry.active.has(graphScope(dir, path))) void runGraph(dir, path, true);
}

/** Approve a ticket in review (or force-complete any ticket). */
export function approveTicket(dir: string, path: string[], ticketId: string): void {
  store.updateTicket(dir, path, ticketId, (t) => ({ ...t, status: "done" }));
  // If a graph run was waiting on this review, let it continue.
  if (registry.active.has(graphScope(dir, path))) void runGraph(dir, path, true);
}

/** Run a ticket: leaf tickets go to the agent, tickets with a subgraph run the subgraph. */
export async function runTicket(
  dir: string,
  path: string[],
  ticketId: string
): Promise<void> {
  registry.userStopped.delete(ticketScope(dir, path, ticketId));
  const project = store.getProject(dir);
  if (!project) return;
  const ticket = ticketAtPath(project.graph, path, ticketId);
  if (!ticket) return;

  if (ticket.subgraph.tickets.length > 0) {
    store.updateTicket(dir, path, ticketId, (t) => ({ ...t, status: "running" }));
    await runGraph(dir, [...path, ticketId]);
    // isTicketDone, not "every child done": a human ticket keeps its own
    // sign-off, so a drained board leaves it waiting on its person.
    store.updateTicket(dir, path, ticketId, (t) => ({
      ...t,
      status: isTicketDone(t) ? "done" : "todo",
    }));
  } else if (ticket.type === "human_review" && !isBoard(dir, path)) {
    // A human ticket with no board has nothing for an agent to do: it is a
    // gate, so running it just hands it to the person. (Their own messages
    // still open a session — that goes through sendFeedback.) A card on a
    // board is the opposite: the human already said what they want, so it
    // runs like any other leaf and lands in review when the agent is done.
    store.updateTicket(dir, path, ticketId, (t) => ({ ...t, status: "review" }));
  } else {
    await runLeafTicket(dir, path, ticketId);
  }
}

/**
 * Run every ticket in the graph at `path`, respecting dependency edges.
 * All ready tickets run in parallel, each in its own agent session; whenever
 * one finishes, newly-unblocked tickets are started. Stops branches at
 * human-review tickets until they are approved; approving resumes the run
 * automatically.
 */
export async function runGraph(
  dir: string,
  path: string[],
  resume = false
): Promise<void> {
  const k = graphScope(dir, path);
  // Pressing run lifts the user-stopped skip from this level's tickets; only an
  // internal resume (an approval, a rejection, a finished subgraph) keeps it, so
  // approving one review never restarts work the user deliberately stopped.
  // This cannot be inferred from `active`: a run parked on a human gate stays
  // active until the gate is answered, which would freeze the skip for good.
  if (!resume)
    for (const key of [...registry.userStopped])
      if (key.startsWith(k + "#")) registry.userStopped.delete(key);
  registry.active.add(k);
  if (registry.loops.has(k)) return; // a scheduler loop is already draining this graph
  registry.loops.add(k);
  notifyRuns(dir);

  const inFlight = new Map<string, Promise<void>>(); // ticket ids currently running

  try {
    for (;;) {
      // Start everything currently ready (unless the user stopped the run).
      if (registry.active.has(k)) {
        const project = store.getProject(dir);
        const g = project && graphAtPath(project.graph, path);
        if (!g) break;
        const ready = g.tickets.filter((t) => {
          if (inFlight.has(t.id) || isTicketDone(t)) return false;
          if (registry.userStopped.has(ticketScope(dir, path, t.id))) return false;
          if (!dependenciesOf(g, t.id).every(satisfiesDependents)) return false;
          // Parents are ready only while something inside can actually progress.
          if (t.subgraph.tickets.length > 0) return hasRunnableWork(t.subgraph);
          return t.status === "todo";
        });
        for (const t of ready) {
          inFlight.set(
            t.id,
            runTicket(dir, path, t.id)
              .catch((err) =>
                store.appendLog(dir, path, t.id, {
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
    // The loop only ever waits on work in flight, so leaving it means this
    // level has settled: nothing beneath it is executing any more.
    registry.loops.delete(k);
    const project = store.getProject(dir);
    const g = project && graphAtPath(project.graph, path);
    // Keep the resume flag only while a human still owes an answer (at any
    // depth) — a ticket in review, or a human ticket nobody has signed off yet
    // — so their approval resumes the run. A human ticket whose board is fully
    // Done is still one of those: only "All good" finishes it.
    const anyGate = (g2: { tickets: Ticket[] }): boolean =>
      g2.tickets.some(
        (t) =>
          t.status === "review" ||
          (t.type === "human_review" && !isTicketDone(t)) ||
          anyGate(t.subgraph)
      );
    if (!g || !anyGate(g)) registry.active.delete(k);

    // If this subgraph just fully completed, mark its parent ticket done and
    // let a paused parent run continue past it. A human parent is the
    // exception: its board draining is what it waits on its person for.
    const allDone = !!g && g.tickets.length > 0 && g.tickets.every(isTicketDone);
    if (allDone && path.length > 0) {
      const parentPath = path.slice(0, -1);
      store.updateTicket(dir, parentPath, path[path.length - 1], (t) =>
        t.type === "human_review" ? t : { ...t, status: "done" }
      );
      if (registry.active.has(graphScope(dir, parentPath)))
        void runGraph(dir, parentPath, true);
    }
    notifyRuns(dir);
  }
}

/** True while a run is genuinely at work at or beneath this ticket: an open
 * agent session, or a scheduler loop draining its subgraph (which is what
 * carries a ticket between two of its children's sessions). */
function liveBeneath(dir: string, path: string[], t: Ticket): boolean {
  if (registry.controllers.has(ticketScope(dir, path, t.id))) return true;
  if (registry.loops.has(graphScope(dir, [...path, t.id]))) return true;
  return t.subgraph.tickets.some((c) => liveBeneath(dir, [...path, t.id], c));
}

/** Does a live run own this ticket's run state? (A person's own status edit
 * must not overwrite a run in progress.) */
export function ownsTicket(dir: string, path: string[], id: string): boolean {
  const project = store.getProject(dir);
  const t = project && ticketAtPath(project.graph, path, id);
  return !!t && liveBeneath(dir, path, t);
}

/** A zombie "running" — a persisted status whose run died with the server
 * process — has nothing to abort and nothing that will ever write a final
 * status, so settle it back to todo (to review for a human ticket with no
 * board: it is a gate, so it belongs to its person, not to the scheduler).
 * Live runs settle themselves after the abort (and must not be reset here: a
 * todo leaf would make the parent's scheduler consider it runnable again and
 * restart it). */
function settleZombie(dir: string, path: string[], ticketId: string): void {
  const project = store.getProject(dir);
  const t = project && ticketAtPath(project.graph, path, ticketId);
  if (t && t.status === "running" && !liveBeneath(dir, path, t))
    store.updateTicket(dir, path, ticketId, (x) => ({
      ...x,
      status:
        x.type === "human_review" &&
        x.subgraph.tickets.length === 0 &&
        !isBoard(dir, path)
          ? "review"
          : "todo",
    }));
}

/** Settle every ticket left marked running that no live run backs: after a
 * server restart that is every one of them, and while the server is up it is
 * exactly the ones whose run is gone. The registry answers, so this never
 * settles a ticket that is genuinely running. */
export function settleZombies(dir: string, path: string[] = []): void {
  const project = store.getProject(dir);
  const g = project && graphAtPath(project.graph, path);
  for (const t of g?.tickets ?? []) {
    settleZombies(dir, [...path, t.id]);
    settleZombie(dir, path, t.id);
  }
}

/** Abort a ticket's run (and its subgraph's) without marking it user-stopped;
 * rejectTicket uses this so the rejected work is free to re-run right away. */
function abortRun(dir: string, path: string[], ticketId: string): void {
  registry.controllers.get(ticketScope(dir, path, ticketId))?.abort();
  const project = store.getProject(dir);
  const t = project && ticketAtPath(project.graph, path, ticketId);
  // A ticket with a subgraph runs as a graph run underneath, not a controller.
  if (t && t.subgraph.tickets.length > 0) stopGraph(dir, [...path, ticketId]);
  settleZombie(dir, path, ticketId);
}

export function stopTicket(dir: string, path: string[], ticketId: string): void {
  registry.userStopped.add(ticketScope(dir, path, ticketId));
  abortRun(dir, path, ticketId);
  notifyRuns(dir);
}

export function stopGraph(dir: string, path: string[]): void {
  registry.active.delete(graphScope(dir, path));
  const project = store.getProject(dir);
  const g = project && graphAtPath(project.graph, path);
  for (const t of g?.tickets ?? []) {
    registry.controllers.get(ticketScope(dir, path, t.id))?.abort();
    if (t.subgraph.tickets.length > 0) stopGraph(dir, [...path, t.id]);
    settleZombie(dir, path, t.id);
  }
  notifyRuns(dir);
}

/** True while this graph's run is actually executing: its scheduler loop is
 * draining work, which includes everything nested beneath it. A run parked on
 * a human gate is *not* running — `active` remembers that it wants to continue. */
export function isGraphRunning(dir: string, path: string[]): boolean {
  return registry.loops.has(graphScope(dir, path));
}
