import { readProject, writeProject } from "../projects-fs";
import { rewrite } from "../run-state";
import { LogEntry, Project, Ticket } from "../types";

/**
 * The server process's copy of every open project. Runs live here, so this —
 * not the browser — is the authority on run-produced state, and every write
 * (from a run or from a client PUT) goes through it. Disk writes are debounced;
 * readers always see the in-memory copy, so a run's progress is visible to a
 * client that connects a second later with no tab having been open.
 */

/** What the live subscription carries to whichever clients are watching. */
export type ProjectEvent =
  | { type: "ticket"; path: string[]; id: string; patch: Partial<Ticket> }
  | { type: "log"; path: string[]; id: string; entries: LogEntry[] }
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
  if (found) return found;
  const project = readProject(dir);
  if (!project) return null;
  const fresh: Entry = { project, timer: null, listeners: new Set() };
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

export function updateTicket(
  dir: string,
  path: string[],
  id: string,
  fn: (t: Ticket) => Ticket
): void {
  const e = entry(dir);
  if (!e) return;
  let before: Ticket | null = null;
  let after: Ticket | null = null;
  const graph = rewrite(e.project.graph, path, (g) => ({
    ...g,
    tickets: g.tickets.map((t) => {
      if (t.id !== id) return t;
      before = t;
      after = fn(t);
      return after;
    }),
  }));
  if (!before || !after) return;
  const was = before as Ticket;
  const now = after as Ticket;
  if (was === now) return;
  e.project = { ...e.project, graph };
  scheduleWrite(dir, e);

  const patch: Partial<Ticket> = {};
  if (was.status !== now.status) patch.status = now.status;
  if (was.sessionId !== now.sessionId) patch.sessionId = now.sessionId;
  if (was.resultSummary !== now.resultSummary) patch.resultSummary = now.resultSummary;
  if (was.stats !== now.stats) patch.stats = now.stats;
  // A stop the person made elsewhere (the toolbar, the ticket panel) reaches
  // the open board this way: without it the card sits in Working saying Queued
  // while the scheduler has quietly parked it.
  if (was.paused !== now.paused) patch.paused = now.paused;
  if (Object.keys(patch).length > 0) publish(dir, { type: "ticket", path, id, patch });
}

export function appendLog(
  dir: string,
  path: string[],
  id: string,
  entryToAdd: LogEntry
): void {
  const e = entry(dir);
  if (!e) return;
  e.project = {
    ...e.project,
    graph: rewrite(e.project.graph, path, (g) => ({
      ...g,
      tickets: g.tickets.map((t) =>
        t.id === id ? { ...t, log: [...t.log, entryToAdd] } : t
      ),
    })),
  };
  scheduleWrite(dir, e);
  publish(dir, { type: "log", path, id, entries: [entryToAdd] });
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
