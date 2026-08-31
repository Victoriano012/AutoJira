import {
  Attachment,
  contextChain,
  dependenciesOf,
  fileBlockedBy,
  graphAtPath,
  isTicketDone,
  notReadyReason,
  Project,
  satisfiesDependents,
  SchedulerFacts,
  Ticket,
  ticketAtPath,
  TicketGraph,
} from "../types";
import { resumableSession } from "../agent-session";
import { selectedModel } from "../config";
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
  /** Human messages waiting for a ticket's files to come free, by ticket key. */
  pendingFeedback: Map<string, string>;
  /** Extra indications typed on a card whose agent is at work, by ticket key.
   * The ticket's own run loop takes them and resumes its session with them —
   * nothing else may, or there would be two agents in one workspace. */
  notes: Map<string, string[]>;
  /** Wakes a scheduler loop that is waiting on its runs, so it can pick up work
   * that appeared since (a card added while another card was running). */
  wakes: Map<string, () => void>;
}

const globals = globalThis as unknown as { __autojiraRegistry?: Registry };
const registry: Registry = (globals.__autojiraRegistry ??= {
  controllers: new Map(),
  active: new Set(),
  loops: new Set(),
  userStopped: new Set(),
  pendingFeedback: new Map(),
  notes: new Map(),
  wakes: new Map(),
});
// A dev-server hot reload keeps the old registry object, which predates these.
registry.pendingFeedback ??= new Map();
registry.notes ??= new Map();
registry.wakes ??= new Map();

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
  const ctx = contextChain(project, path);
  const crumb = ctx.slice(1).map((l) => l.title);
  const parentContext = ctx.slice(1).filter((l) => l.description);

  const lines = [
    `You are an autonomous engineer working on the project "${project.name}" inside the current working directory. Do the work described by the ticket below directly in this directory.`,
    project.description && `\nProject description:\n${project.description}`,
    crumb.length > 0 && `\nThis ticket is a subtask of: ${crumb.join(" > ")}`,
    parentContext.length > 0 &&
      `\nContext from parent tickets (applies to this ticket too):\n` +
        parentContext.map((l) => `- ${l.title}: ${l.description}`).join("\n"),
    deps.length > 0 &&
      `\nCompleted tickets this one depends on:\n` +
        deps.map((d) => `- ${d.title}: ${d.resultSummary ?? "(done)"}`).join("\n"),
    `\n## Ticket: ${ticket.title}\n${ticket.description || "(no further description)"}`,
    ticket.type === "human_review"
      ? `\nA human will review this ticket when you finish. If the workspace is a git repository, commit your work when done (one commit, message = ticket title). End your reply with (1) a 2-4 sentence summary of what you did and (2) a short checklist of what the human should test.`
      : `\nWork autonomously without asking questions. If the workspace is a git repository, commit your work when done (one commit, message = ticket title). End your reply with a 2-4 sentence summary of what you did, so dependent tickets can build on it.`,
  ];
  return lines.filter(Boolean).join("\n");
}

// ---- notes the person adds to a card in flight ----------------------------

/** Take the indications waiting for this ticket's agent. Always drains: the
 * board writes each one into the ticket itself as well, so the durable copy is
 * the ticket's description and this queue only carries the live hand-over. */
function takeNotes(key: string): string[] {
  const notes = registry.notes.get(key) ?? [];
  registry.notes.delete(key);
  return notes;
}

/** What an aborted session says in the log: the person's stop — unless it was
 * their own note interrupting the agent, which the run resumes from. */
function abortText(key: string): string {
  return registry.notes.has(key)
    ? "Taking your indication into account…"
    : "Stopped by user";
}

// ---- one agent session ----------------------------------------------------

async function runAgentSession(
  dir: string,
  path: string[],
  ticketId: string,
  body: {
    prompt: string;
    sessionId?: string;
    attachments?: Attachment[];
    model?: string;
  }
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
      model: body.model,
      writeAccess: true,
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
        // An error the abort itself caused is not the run's own failure — the
        // CLI reports the interrupt as one. What actually happened (the person's
        // stop, or their note) is logged below instead.
        if (!ctrl.signal.aborted) {
          store.appendLog(dir, path, ticketId, {
            kind: "error",
            text: ev.message,
            ts: Date.now(),
          });
        }
      }
    }
    if (ctrl.signal.aborted) {
      ok = false;
      finalText = "Stopped by user";
      store.appendLog(dir, path, ticketId, {
        kind: "info",
        text: abortText(key),
        ts: Date.now(),
      });
    }
  } catch (err) {
    ok = false;
    // A user stop is not a failure: log it as info, not error.
    finalText = ctrl.signal.aborted ? "Stopped by user" : String(err);
    store.appendLog(dir, path, ticketId, {
      kind: ctrl.signal.aborted ? "info" : "error",
      text: ctrl.signal.aborted ? abortText(key) : finalText,
      ts: Date.now(),
    });
  } finally {
    registry.controllers.delete(key);
    notifyRuns(dir);
  }
  return { ok, text: finalText, aborted: ctrl.signal.aborted };
}

/**
 * The ticket's session, and any session the person's own indications ask for
 * after it. A note typed on the card interrupts the open session (see
 * `noteTicket`); this resumes that same session with what they said, so
 * everything the agent had already done stays in its context, the ticket keeps
 * its "running" status throughout — the card never leaves Working — and there
 * is never a second agent in one workspace. Normally exactly one pass.
 */
async function runWithNotes(
  dir: string,
  path: string[],
  ticketId: string,
  body: {
    prompt: string;
    sessionId?: string;
    attachments?: Attachment[];
    model: string;
  }
): Promise<{ ok: boolean; text: string; aborted: boolean }> {
  const key = ticketScope(dir, path, ticketId);
  for (;;) {
    const outcome = await runAgentSession(dir, path, ticketId, body);
    const notes = takeNotes(key);
    if (notes.length === 0 || registry.userStopped.has(key)) return outcome;
    const project = store.getProject(dir);
    const resumed = resumableSession(
      project ? ticketAtPath(project.graph, path, ticketId)?.sessionId : undefined,
      body.model
    )?.stored;
    // No session to resume (the agent never reached init): the ticket settles,
    // and the indication is still in its description for the next run.
    if (!resumed) return outcome;
    body = {
      prompt:
        `While you were working, the person added indications for this ticket:\n\n` +
        notes.join("\n\n") +
        `\n\nTake them into account and carry on with the ticket, then finish as instructed above.`,
      sessionId: resumed,
      model: body.model,
    };
  }
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

/**
 * The person's stop, written where everyone can see it.
 *
 * `userStopped` lives in the registry, so it is invisible to the board: a card
 * held out of the queue by it alone sits in the Working column labelled Queued
 * with nothing ever starting it, which is exactly the lie this whole invariant
 * exists to prevent. `paused` is the persisted half of the same fact — the
 * board reads it (`boardColumn` → Blocked, "Paused", with a Run button back)
 * and it survives a server restart, which the skip never did.
 *
 * Only ever written once the ticket is out of "running": the board clears a
 * pause it sees on a card whose agent is still winding down, so a run being
 * aborted parks itself in the same write that settles its status (see
 * `runLeafTicket`).
 *
 * And only on "todo", the one status that can lie: that is the card the board
 * shows in Working as Queued. A card in review or error already says what it
 * is, and parking it would move it out of the column the person left it in.
 */
function park(dir: string, path: string[], ticketId: string): void {
  const project = store.getProject(dir);
  const t = project && ticketAtPath(project.graph, path, ticketId);
  if (!t || t.paused || t.status !== "todo" || isTicketDone(t)) return;
  store.updateTicket(dir, path, ticketId, (x) => ({ ...x, paused: true }));
}

/** The other half of lifting the skip: pressing run un-parks the ticket, or it
 * would be blocked by the stop it was just started out of. */
function unpark(dir: string, path: string[], ticketId: string): void {
  const project = store.getProject(dir);
  const t = project && ticketAtPath(project.graph, path, ticketId);
  if (t?.paused) store.updateTicket(dir, path, ticketId, (x) => ({ ...x, paused: false }));
}

/** Run one leaf ticket (no subgraph) with the agent. */
async function runLeafTicket(dir: string, path: string[], ticketId: string): Promise<void> {
  const project = store.getProject(dir);
  if (!project) return;
  const ticket = ticketAtPath(project.graph, path, ticketId);
  if (!ticket || ticket.status === "running") return;

  store.updateTicket(dir, path, ticketId, (t) => ({ ...t, status: "running" }));
  store.appendLog(dir, path, ticketId, { kind: "info", text: "Run started", ts: Date.now() });

  const { ok, text, aborted } = await runWithNotes(dir, path, ticketId, {
    prompt: buildPrompt(project, path, ticket),
    attachments: inheritedAttachments(project, path, ticket),
    model: selectedModel(),
  });

  const summary = text.length > 1500 ? text.slice(0, 1500) + "…" : text;
  // The person's stop and the settled status land in one write: a card that
  // went back to todo because they stopped it must never be seen as Queued.
  const stopped = registry.userStopped.has(ticketScope(dir, path, ticketId));
  // Skip the final write if something else already moved the ticket out of
  // "running" (e.g. a board rejection reset it to todo while aborting).
  // A user stop is not a failure: the ticket goes back to todo, and "error"
  // stays reserved for runs where the agent actually failed.
  store.updateTicket(dir, path, ticketId, (t) =>
    t.status !== "running"
      ? t
      : aborted
        ? { ...t, status: "todo", ...(stopped ? { paused: true } : {}) }
        : {
            ...t,
            status: !ok ? "error" : t.type === "human_review" ? "review" : "done",
            resultSummary: summary,
          }
  );
}

/**
 * An extra indication the person typed on an in-progress card (the board's note
 * button), for that ticket's own agent and nothing else.
 *
 * It never starts one. A card the scheduler has not started is standing still
 * for a reason — a dependency, another card in its files, the person's own
 * pause — and starting an agent from here would break exactly the rule that
 * kept it out of the queue, so the only card whose agent hears this now is one
 * whose session is genuinely open: it is interrupted, and its run loop
 * (`runLeafTicket`) resumes the same session with the indication. Every other
 * card already carries the indication in its description, written by the board
 * before this call, so its run reads it whenever it does start — which is why
 * nothing here has to be kept for it, and why a server restart cannot lose it.
 */
export function noteTicket(
  dir: string,
  path: string[],
  ticketId: string,
  message: string
): void {
  const text = message.trim();
  const project = store.getProject(dir);
  const g = project && graphAtPath(project.graph, path);
  const ticket = project && ticketAtPath(project.graph, path, ticketId);
  if (!g || !ticket || !text) return;

  store.appendLog(dir, path, ticketId, { kind: "user", text, ts: Date.now() });

  const key = ticketScope(dir, path, ticketId);
  if (ticket.status === "running") {
    registry.notes.set(key, [...(registry.notes.get(key) ?? []), text]);
    // The interrupt is what makes it live; the run loop does the rest. A ticket
    // marked running with no session left to interrupt (a restart settles those)
    // still has the indication in its description.
    registry.controllers.get(key)?.abort();
    return;
  }

  // Not running: say when the agent will read it, in the scheduler's own words.
  const why = notReadyReason(g, ticket, isBoard(dir, path), schedulerFacts(dir, path));
  const waiting = why?.startsWith("waiting") ? ` (${why})` : "";
  store.appendLog(dir, path, ticketId, {
    kind: "info",
    text:
      ticket.status === "error"
        ? "Noted — the agent gets this when you retry the card."
        : // The card finished between the person pressing send and this: their
          // ✕ is what puts its agent back to work now.
          ticket.status === "review"
          ? "Noted — the card just reached review; the agent gets this if you send it back."
          : `Noted — the agent gets this when the card starts${waiting}.`,
    ts: Date.now(),
  });
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

  // Answering a ticket puts its agent back to work, which re-claims its files —
  // and another ticket may have taken one of them while it sat in review. The
  // message waits with the ticket rather than starting a second agent in that
  // file; the scheduler delivers it (see runTicket) as soon as the file frees.
  const g = graphAtPath(project.graph, path);
  const claim = g && fileBlockedBy(g, ticketId, isBoard(dir, path));
  if (claim) {
    const key = ticketScope(dir, path, ticketId);
    const queued = registry.pendingFeedback.get(key);
    registry.pendingFeedback.set(key, queued ? `${queued}\n\n${message}` : message);
    store.appendLog(dir, path, ticketId, {
      kind: "info",
      text: `Waiting for ${claim.file}: “${claim.by.title}” is changing it.`,
      ts: Date.now(),
    });
    store.updateTicket(dir, path, ticketId, (t) => ({ ...t, status: "todo" }));
    return;
  }

  store.appendLog(dir, path, ticketId, { kind: "user", text: message, ts: Date.now() });
  store.updateTicket(dir, path, ticketId, (t) => ({ ...t, status: "running" }));
  const model = selectedModel();
  const activeSession = resumableSession(ticket.sessionId, model)?.stored;

  const { ok, text, aborted } = await runWithNotes(dir, path, ticketId, {
    // With no session the ticket never ran, so this is the human opening the
    // work rather than reacting to it.
    prompt: activeSession
      ? `Human review feedback on your work for this ticket:\n\n${message}\n\nAddress the feedback, then end with a short summary of what you changed.`
      : `${buildPrompt(project, path, ticket)}\n\nThe human is starting this ticket with a request:\n\n${message}`,
    sessionId: activeSession,
    model,
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
  // An answered ticket can unblock the rest of its board (its files come free,
  // its dependents are satisfied) and nothing else here would notice.
  autoRun(dir, path);
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
  // The reset downstream tickets are runnable again once the fix lands —
  // restart the scheduler if this graph's run is still active.
  if (registry.active.has(graphScope(dir, path))) void runGraph(dir, path, true);
  else autoRun(dir, path);
}

/** Approve a ticket in review (or force-complete any ticket). */
export function approveTicket(dir: string, path: string[], ticketId: string): void {
  store.updateTicket(dir, path, ticketId, (t) => ({ ...t, status: "done" }));
  // If a graph run was waiting on this review, let it continue. Approving also
  // releases the ticket's files, which may be all a card on this board needed.
  if (registry.active.has(graphScope(dir, path))) void runGraph(dir, path, true);
  else autoRun(dir, path);
}

/** Run a ticket: leaf tickets go to the agent, tickets with a subgraph run the subgraph. */
export async function runTicket(
  dir: string,
  path: string[],
  ticketId: string
): Promise<void> {
  registry.userStopped.delete(ticketScope(dir, path, ticketId));
  unpark(dir, path, ticketId);
  const project = store.getProject(dir);
  if (!project) return;
  const ticket = ticketAtPath(project.graph, path, ticketId);
  if (!ticket) return;

  // The scheduler filters these out, so this catches the person pressing Run on
  // a card whose file someone else is already in. Saying so beats doing nothing.
  const g = graphAtPath(project.graph, path);
  const claim = g && fileBlockedBy(g, ticketId, isBoard(dir, path));
  if (claim) {
    store.appendLog(dir, path, ticketId, {
      kind: "info",
      text: `Waiting for ${claim.file}: “${claim.by.title}” is changing it.`,
      ts: Date.now(),
    });
    return;
  }

  // A message that arrived while the ticket's file was taken: now that it is
  // free, the ticket goes back to its own agent with what the person said.
  const waiting = registry.pendingFeedback.get(ticketScope(dir, path, ticketId));
  if (waiting) {
    registry.pendingFeedback.delete(ticketScope(dir, path, ticketId));
    await sendFeedback(dir, path, ticketId, waiting);
    return;
  }

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

  // What just finished may have unblocked another card. Inside a scheduler loop
  // this only nudges a loop that was going to look anyway; outside one — the run
  // button, an unpause, an answered chat — it is the only thing that would.
  autoRun(dir, path);
}

/** The tickets in this graph an agent could be started on right now. The
 * scheduler dispatches exactly these, and `autoRun` asks the same question to
 * decide whether starting a scheduler is worth it — one definition, so the two
 * can never disagree and spin. */
function readyTickets(dir: string, path: string[], g: TicketGraph): Ticket[] {
  // On a board a card in review is finished agent work, not a gate: the cards
  // after it may start. In the graph view a human ticket holds them.
  // The rules themselves live in `notReadyReason`, which the board also uses to
  // check that a card it shows in Working really is about to run. Only the two
  // facts that exist solely in this process are supplied from here.
  const onBoard = isBoard(dir, path);
  const facts = schedulerFacts(dir, path);
  return g.tickets.filter((t) => notReadyReason(g, t, onBoard, facts) === null);
}

/** The two facts `notReadyReason` cannot know: which of this graph's tickets
 * the person stopped, and which subgraphs are already being drained. */
function schedulerFacts(dir: string, path: string[]): SchedulerFacts {
  return {
    stopped: (id: string) => registry.userStopped.has(ticketScope(dir, path, id)),
    draining: (id: string) => registry.loops.has(graphScope(dir, [...path, id])),
  };
}

/**
 * A board runs itself: the moment a card can start it gets its agent, rather
 * than sitting queued until somebody presses run. Cheap and safe to call after
 * anything that could have unblocked a card — a new card from the request bar,
 * an approval, a finished run releasing a file — because it starts a scheduler
 * only when there is a card it could actually dispatch, and `runGraph` is a
 * no-op while a loop is already draining the graph.
 *
 * Boards only. The graph view is a plan the person runs deliberately; a board
 * is a request they already made, so waiting there is just latency.
 */
export function autoRun(dir: string, path: string[]): void {
  if (!isBoard(dir, path)) return;
  const k = graphScope(dir, path);
  // A loop is already draining this board, but it is asleep until one of its
  // runs finishes — which is why a card added next to a running one used to sit
  // queued for as long as that card took. Wake it so it looks again now.
  if (registry.loops.has(k)) {
    registry.wakes.get(k)?.();
    return;
  }
  const project = store.getProject(dir);
  const g = project && graphAtPath(project.graph, path);
  if (!g || readyTickets(dir, path, g).length === 0) return;
  // resume: never lift the person's stop just because the board moved on.
  void runGraph(dir, path, true);
}

/** Every board in the project gets the same treatment, for the paths that
 * change a board from outside a run — the browser's autosave adding cards. */
export function autoRunBoards(dir: string, path: string[] = []): void {
  const project = store.getProject(dir);
  const g = project && graphAtPath(project.graph, path);
  for (const t of g?.tickets ?? []) {
    if (t.subgraph.tickets.length === 0) continue;
    if (t.type === "human_review") autoRun(dir, [...path, t.id]);
    else autoRunBoards(dir, [...path, t.id]);
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
  if (!resume) {
    for (const key of [...registry.userStopped])
      if (key.startsWith(k + "#")) registry.userStopped.delete(key);
    const p = store.getProject(dir);
    for (const t of (p && graphAtPath(p.graph, path))?.tickets ?? [])
      unpark(dir, path, t.id);
  }
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
        const ready = readyTickets(dir, path, g).filter((t) => !inFlight.has(t.id));
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
      // Wake when any ticket finishes — or when `autoRun` says new work landed
      // on this graph — then recompute the ready set.
      const woken = new Promise<void>((resolve) => registry.wakes.set(k, resolve));
      await Promise.race([...inFlight.values(), woken]);
      registry.wakes.delete(k);
    }
  } finally {
    // The loop only ever waits on work in flight, so leaving it means this
    // level has settled: nothing beneath it is executing any more.
    registry.loops.delete(k);
    registry.wakes.delete(k);
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
  // A ticket with no live agent parks now; one still winding down parks in the
  // write that settles it (see runLeafTicket).
  park(dir, path, ticketId);
  notifyRuns(dir);
}

/** `byUser` is the person pressing Stop: its tickets are marked user-stopped so
 * nothing (a board's own auto-run included) starts them again until the person
 * presses run. An internal stop — rejecting work so it can be redone — leaves
 * them free to run. */
export function stopGraph(dir: string, path: string[], byUser = false): void {
  registry.active.delete(graphScope(dir, path));
  const project = store.getProject(dir);
  const g = project && graphAtPath(project.graph, path);
  for (const t of g?.tickets ?? []) {
    if (byUser && !isTicketDone(t)) registry.userStopped.add(ticketScope(dir, path, t.id));
    registry.controllers.get(ticketScope(dir, path, t.id))?.abort();
    if (t.subgraph.tickets.length > 0) stopGraph(dir, [...path, t.id]);
    settleZombie(dir, path, t.id);
    // Same as stopTicket: the stop has to be visible, or every card this just
    // took out of the queue keeps saying Queued for good.
    if (byUser) park(dir, path, t.id);
  }
  notifyRuns(dir);
}

/** True while this graph's run is actually executing: its scheduler loop is
 * draining work, which includes everything nested beneath it. A run parked on
 * a human gate is *not* running — `active` remembers that it wants to continue. */
export function isGraphRunning(dir: string, path: string[]): boolean {
  return registry.loops.has(graphScope(dir, path));
}
