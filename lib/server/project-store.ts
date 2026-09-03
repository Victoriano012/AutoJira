import { readProject, writeProject } from "../projects-fs";
import type { AgentRequest, ChatEntry, LogEntry, Mode, Project, Ticket } from "../types";

/**
 * The server process's copy of every open project. Runs live here, so this —
 * not the browser — is the authority on run-produced state, and every write
 * (from a run or from a client PUT) goes through it. Disk writes are debounced;
 * readers always see the in-memory copy, so a run's progress is visible to a
 * client that connects a second later with no tab having been open.
 */

/** What the live subscription carries to whichever clients are watching. */
export type ProjectEvent =
  | { type: "ticket"; id: string; patch: Partial<Ticket> }
  | { type: "log"; id: string; entries: LogEntry[] }
  /** Set changes made on the server (the project agent's tickets, deletions). */
  | { type: "tickets"; added: Ticket[]; removed: string[] }
  | { type: "chat"; entries: ChatEntry[] }
  /** The project agent's turn began or ended, or its request stack changed. */
  | { type: "agent"; busy: boolean; mode: Mode | null; requests: AgentRequest[] }
  | { type: "notes"; notes: string[] }
  | { type: "runs" };

interface Entry {
  project: Project;
  timer: ReturnType<typeof setTimeout> | null;
  listeners: Set<(e: ProjectEvent) => void>;
}

// Module state must survive dev hot-reloads, or a recompile would orphan every
// live run's bookkeeping.
const globals = globalThis as unknown as {
  __autoprojectProjects?: Map<string, Entry>;
};
const entries: Map<string, Entry> = (globals.__autoprojectProjects ??= new Map());

const WRITE_DEBOUNCE_MS = 250;

function entry(dir: string): Entry | null {
  const found = entries.get(dir);
  // The map outlives hot reloads, so it can still hold a project loaded by the
  // graph-era code; only a fresh read runs the on-disk migration.
  if (found && Array.isArray(found.project.tickets)) return found;
  if (found?.timer) clearTimeout(found.timer);
  const project = readProject(dir);
  if (!project) return null;
  const fresh: Entry = { project, timer: null, listeners: found?.listeners ?? new Set() };
  entries.set(dir, fresh);
  return fresh;
}

/** True when this call is what pulled the project into memory. */
export function isLoaded(dir: string): boolean {
  return entries.has(dir);
}

export function getProject(dir: string): Project | null {
  return entry(dir)?.project ?? null;
}

export function subscribe(dir: string, fn: (e: ProjectEvent) => void): () => void {
  const e = entry(dir);
  if (!e) return () => {};
  e.listeners.add(fn);
  return () => {
    e.listeners.delete(fn);
  };
}

export function publish(dir: string, event: ProjectEvent): void {
  const e = entries.get(dir);
  if (!e) return;
  for (const fn of [...e.listeners]) fn(event);
}

function scheduleWrite(dir: string, e: Entry): void {
  if (e.timer) return;
  e.timer = setTimeout(() => {
    e.timer = null;
    try {
      writeProject(dir, e.project);
    } catch {
      // The folder can vanish under us; nothing useful to do here.
    }
  }, WRITE_DEBOUNCE_MS);
  // Never keep the process alive just to flush.
  e.timer.unref?.();
}

/** Replace the whole project (a client's autosave, already merged). */
export function setProject(dir: string, project: Project): void {
  const e = entry(dir);
  if (!e) return;
  e.project = project;
  scheduleWrite(dir, e);
}

/** Change one ticket in place. The one place a run-driven status change is
 * stamped: `statusChangedAt` is set here whenever `status` moves, so every
 * writer in runs.ts gets it for free and the columns can order by it. */
export function updateTicket(dir: string, id: string, fn: (t: Ticket) => Ticket): void {
  const e = entry(dir);
  if (!e) return;
  let before: Ticket | null = null;
  let after: Ticket | null = null;
  const tickets = e.project.tickets.map((t) => {
    if (t.id !== id) return t;
    before = t;
    after = fn(t);
    if (after !== t && after.status !== t.status) {
      after = { ...after, statusChangedAt: Date.now() };
    }
    return after;
  });
  if (!before || !after) return;
  const was = before as Ticket;
  const now = after as Ticket;
  if (was === now) return;
  e.project = { ...e.project, tickets };
  scheduleWrite(dir, e);

  const patch: Partial<Ticket> = {};
  if (was.status !== now.status) {
    patch.status = now.status;
    patch.statusChangedAt = now.statusChangedAt;
  }
  if (was.sessionId !== now.sessionId) patch.sessionId = now.sessionId;
  if (was.resultSummary !== now.resultSummary) patch.resultSummary = now.resultSummary;
  if (was.stats !== now.stats) patch.stats = now.stats;
  // A stop the person made elsewhere (the toolbar, the ticket panel) reaches
  // the open board this way: without it the card sits in Working saying Queued
  // while the scheduler has quietly parked it.
  if (was.paused !== now.paused) patch.paused = now.paused;
  if (Object.keys(patch).length > 0) publish(dir, { type: "ticket", id, patch });
}

export function appendLog(dir: string, id: string, entryToAdd: LogEntry): void {
  const e = entry(dir);
  if (!e) return;
  e.project = {
    ...e.project,
    tickets: e.project.tickets.map((t) =>
      t.id === id ? { ...t, log: [...t.log, entryToAdd] } : t
    ),
  };
  scheduleWrite(dir, e);
  publish(dir, { type: "log", id, entries: [entryToAdd] });
}

/** Put new tickets on the board (the project agent's). Returns them with
 * their ids, so the caller can name them in the chat. */
export function addTickets(
  dir: string,
  tickets: Pick<Ticket, "title" | "description" | "files">[]
): Ticket[] {
  const e = entry(dir);
  if (!e || tickets.length === 0) return [];
  const added: Ticket[] = tickets.map((t) => ({
    id: crypto.randomUUID(),
    title: t.title,
    description: t.description,
    ...(t.files ? { files: t.files } : {}),
    status: "todo",
    statusChangedAt: Date.now(),
    log: [],
  }));
  e.project = { ...e.project, tickets: [...e.project.tickets, ...added] };
  scheduleWrite(dir, e);
  publish(dir, { type: "tickets", added, removed: [] });
  return added;
}

export function removeTickets(dir: string, ids: string[]): void {
  const e = entry(dir);
  if (!e) return;
  const gone = new Set(ids);
  const removed = e.project.tickets.filter((t) => gone.has(t.id)).map((t) => t.id);
  if (removed.length === 0) return;
  e.project = { ...e.project, tickets: e.project.tickets.filter((t) => !gone.has(t.id)) };
  scheduleWrite(dir, e);
  publish(dir, { type: "tickets", added: [], removed });
}

/** The transcript is bounded: a long act session would otherwise grow
 * project.json (and every snapshot) without limit. */
const CHAT_CAP = 2000;

export function appendChat(dir: string, entries: ChatEntry[]): void {
  const e = entry(dir);
  if (!e || entries.length === 0) return;
  const chat = [...e.project.chat, ...entries];
  e.project = { ...e.project, chat: chat.slice(Math.max(0, chat.length - CHAT_CAP)) };
  scheduleWrite(dir, e);
  publish(dir, { type: "chat", entries });
}

export function setAgentSession(dir: string, sessionId: string | undefined): void {
  const e = entry(dir);
  if (!e || e.project.agentSessionId === sessionId) return;
  e.project = { ...e.project, agentSessionId: sessionId };
  scheduleWrite(dir, e);
}

export function setNotes(dir: string, notes: string[]): void {
  const e = entry(dir);
  if (!e) return;
  e.project = { ...e.project, notes };
  scheduleWrite(dir, e);
  publish(dir, { type: "notes", notes });
}

/** Write pending changes to disk now (tests and shutdown paths). */
export function flush(dir: string): void {
  const e = entries.get(dir);
  if (!e) return;
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  try {
    writeProject(dir, e.project);
  } catch {
    // ignored — see scheduleWrite
  }
}

/** Drop a project from memory (tests; simulating a server restart). */
export function forget(dir: string): void {
  flush(dir);
  entries.delete(dir);
}
