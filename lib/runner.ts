"use client";

import { useStore } from "./store";

/**
 * Runs execute in the server process, not in this tab: this module is the thin
 * client for /api/runs. Starting a run is a request the server owns from then
 * on, so reloading or closing the page leaves it running, and the run's status,
 * logs and session ids are written by the server (they arrive back through the
 * live subscription in sync.ts).
 *
 * The exported API is unchanged from when the browser drove the runs.
 */

/** What the server says is actually live, keyed exactly as it always was. */
export interface RunStateSnapshot {
  /** pathKeys whose scheduler loop is draining work. */
  loops: string[];
  /** pathKeys of runs that want to continue, including parked on a human gate. */
  active: string[];
  /** ticketKeys with a live agent session. */
  tickets: string[];
}

const pathKey = (path: string[]) => path.join("/") || "(root)";
const ticketKey = (path: string[], id: string) => pathKey(path) + "#" + id;

let state: RunStateSnapshot = { loops: [], active: [], tickets: [] };
// Watchers of the run state (the toolbar). Pushed, not polled.
const runListeners = new Set<() => void>();

/** Subscribe to run-state changes; returns the unsubscribe. */
export function subscribeRuns(fn: () => void): () => void {
  runListeners.add(fn);
  return () => {
    runListeners.delete(fn);
  };
}

export function notifyRuns(): void {
  for (const fn of [...runListeners]) fn();
}

/** Adopt the server's run state (the live subscription and every response). */
export function applyRunState(next: RunStateSnapshot): void {
  state = next;
  notifyRuns();
}

/** True while this graph's run is actually executing in the server: its
 * scheduler loop is draining work, which includes everything nested beneath it.
 * A run parked on a human gate is *not* running — the server's `active` set,
 * not this, remembers that a run wants to continue, so approving resumes it. */
export function isGraphRunning(path: string[]): boolean {
  return state.loops.includes(pathKey(path));
}

/** True while a live agent session is open on exactly this ticket. */
export function isTicketRunLive(path: string[], ticketId: string): boolean {
  return state.tickets.includes(ticketKey(path, ticketId));
}

let flushProject: () => Promise<void> = async () => {};
let pokeStream: () => void = () => {};

/** sync.ts registers its feed check here: a person's action is the moment they
 * are watching for a result, so it is the moment to notice a dead feed. */
export function setStreamPoke(fn: () => void): void {
  pokeStream = fn;
}

/** sync.ts registers its autosave flush here: the server runs from its own copy
 * of the project, so pending edits go first. */
export function setProjectFlush(fn: () => Promise<void>): void {
  flushProject = fn;
}

/** Fires an action at the server; false means it never got there. Only worth
 * asking for when somebody is watching for the result of this one action —
 * everything else goes through `call`, since a run's own progress comes back
 * through the live subscription regardless. */
async function post(
  action: string,
  body: { path?: string[]; ticketId?: string; message?: string }
): Promise<boolean> {
  const dir = useStore.getState().projectId;
  if (!dir) return false;
  pokeStream();
  await flushProject();
  try {
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir, action, ...body }),
    });
    const data = (await res.json().catch(() => null)) as {
      runs?: RunStateSnapshot;
    } | null;
    if (data?.runs) applyRunState(data.runs);
    return res.ok;
  } catch {
    // The tab can go away mid-run; the run continues server-side and the live
    // subscription carries whatever happened next.
    return false;
  }
}

async function call(
  action: string,
  body: { path?: string[]; ticketId?: string; message?: string } = {}
): Promise<void> {
  await post(action, body);
}

/** Run a ticket: leaf tickets go to the agent, tickets with a subgraph run the
 * subgraph. Resolves when the run settles server-side. */
export function runTicket(path: string[], ticketId: string): Promise<void> {
  return call("runTicket", { path, ticketId });
}

/** Run every ticket in the graph at `path`, respecting dependency edges.
 * Resolves when that scheduler loop settles server-side. */
export function runGraph(path: string[]): Promise<void> {
  return call("runGraph", { path });
}

/** Send human feedback into the ticket's existing agent session. */
export function sendFeedback(
  path: string[],
  ticketId: string,
  message: string
): Promise<void> {
  return call("sendFeedback", { path, ticketId, message });
}

/**
 * An extra indication for a card that is already in flight (the board's note
 * button on a Blocked or Working card). The board writes it into the ticket
 * first, so the flush inside `call` is what makes the run read it; this hands
 * it to an agent that is working right now. It never starts a card the
 * scheduler is deliberately holding back.
 *
 * Resolves false if it never reached the server — the card says so, because an
 * indication nobody received is the person's to send again.
 */
export function noteTicket(
  path: string[],
  ticketId: string,
  message: string
): Promise<boolean> {
  return post("noteTicket", { path, ticketId, message });
}

/** Reject a ticket in review with feedback (kanban board's red cross). */
export function rejectTicket(
  path: string[],
  ticketId: string,
  message: string
): Promise<void> {
  return call("rejectTicket", { path, ticketId, message });
}

/** Approve a ticket in review (or force-complete any ticket); a graph run
 * parked on this human gate resumes. */
export function approveTicket(path: string[], ticketId: string): void {
  void call("approveTicket", { path, ticketId });
}

export function stopTicket(path: string[], ticketId: string): void {
  void call("stopTicket", { path, ticketId });
}

export function stopGraph(path: string[]): void {
  void call("stopGraph", { path });
}

/** Settle tickets left marked running with no live server run behind them.
 * The server asks its registry, so a genuinely running ticket is never reset;
 * it already does this when it loads a project, which is what makes a stored
 * "running" trustworthy after a restart. */
export function settleZombies(path: string[] = []): void {
  void call("settleZombies", { path });
}
