"use client";

import { applyRunState, RunStateSnapshot, setProjectFlush } from "./runner";
import { useStore } from "./store";
import { mergeRunState, runEdits } from "./run-state";
import { LogEntry, Project, Ticket } from "./types";

async function createOrImport(body: { name?: string; path?: string }) {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const row = await res.json();
  if (!res.ok) throw new Error(row?.error ?? `Request failed (${res.status})`);
  await openProject(row.id);
  return row.id as string;
}

export const createProject = (name: string) => createOrImport({ name });
export const importProject = (path: string) => createOrImport({ path });

export async function openProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  if (!res.ok) {
    // folder gone or .autojira deleted — forget it
    useStore.getState().closeProject();
    return;
  }
  const row = await res.json();
  // The server settles anything a dead process left marked running before it
  // answers, so this data is already the truth about what is running.
  base = row.data;
  useStore.getState().openProject(id, row.data);
}

/** Persist where a project's node sits on the meta-graph (project picker). */
export async function saveMetaPosition(
  id: string,
  pos: { x: number; y: number }
): Promise<void> {
  const url = `/api/projects/${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (!res.ok) return;
  const row = await res.json();
  await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { ...row.data, metaPosition: pos } }),
  });
}

/** "hide" (default) only removes the project from the meta-graph;
 * "erase" permanently deletes its whole folder from the computer. */
export async function deleteProject(
  id: string,
  mode: "hide" | "erase" = "hide"
): Promise<void> {
  await fetch(`/api/projects/${encodeURIComponent(id)}?mode=${mode}`, {
    method: "DELETE",
  });
}

// ---- live run feed -------------------------------------------------------

type StreamEvent =
  | { type: "snapshot"; project: Project; runs: RunStateSnapshot }
  | { type: "runs"; runs: RunStateSnapshot }
  | { type: "ticket"; path: string[]; id: string; patch: Partial<Ticket> }
  | { type: "log"; path: string[]; id: string; entries: LogEntry[] }
  | { type: "ping" };

let source: EventSource | null = null;
/** The last server state applied here — the base a run-field edit is a diff
 * against, so the browser can tell its own deliberate changes (Reopen, a chat
 * session) apart from run output it merely received. */
let base: Project | null = null;
/** True while applying server state, so autosave does not echo it back. */
let applying = false;

function applyRemote(fn: () => void): void {
  applying = true;
  try {
    fn();
  } finally {
    applying = false;
  }
}

function closeStream(): void {
  source?.close();
  source = null;
  applyRunState({ loops: [], active: [], tickets: [] });
}

/** Subscribe to the server's run feed for `dir`: run state, status changes and
 * log lines produced by runs this tab may not have started. EventSource
 * reconnects on its own, and every connection opens with a snapshot, so a
 * reload or a dropped connection catches up in one step. */
function openStream(dir: string): void {
  closeStream();
  if (typeof EventSource === "undefined") return;
  const es = new EventSource(`/api/runs/stream?dir=${encodeURIComponent(dir)}`);
  source = es;
  es.onmessage = (ev) => {
    if (source !== es) return;
    let msg: StreamEvent;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const store = useStore.getState();
    if (store.projectId !== dir || !store.projectLoaded) return;
    if (msg.type === "snapshot") {
      // Run fields from the server, the tab's own unsaved edits kept.
      applyRemote(() =>
        useStore.getState().setProject(mergeRunState(store.project, msg.project))
      );
      applyRunState(msg.runs);
    } else if (msg.type === "runs") {
      applyRunState(msg.runs);
    } else if (msg.type === "ticket") {
      applyRemote(() =>
        store.updateTicket(msg.path, msg.id, (t) => ({ ...t, ...msg.patch }))
      );
    } else if (msg.type === "log") {
      applyRemote(() => {
        for (const entry of msg.entries) store.appendLog(msg.path, msg.id, entry);
      });
    }
  };
}

// ---- autosave ------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/** Push the open project now. Run-field changes the person made since the last
 * server state travel as explicit edits; everything else is plain structure. */
async function push(): Promise<void> {
  const { project, projectId, projectLoaded } = useStore.getState();
  if (!projectId || !projectLoaded) return;
  const edits = base ? runEdits(base, project) : [];
  base = project;
  await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: project, edits }),
  }).catch(() => {});
}

/** Flush pending edits before anything that makes the server read the project
 * (starting a run) — the server runs from its own copy, not this tab's. */
export function flushProject(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  return push();
}

/** Debounced push of the open project to its .autojira dir on every change. */
export function startAutosave(): void {
  if (started) return;
  started = true;
  setProjectFlush(flushProject);
  let prevProject = useStore.getState().project;
  let prevId = useStore.getState().projectId;
  if (prevId) openStream(prevId);

  useStore.subscribe((s) => {
    if (s.projectId !== prevId) {
      prevId = s.projectId;
      prevProject = s.project;
      base = s.projectId ? s.project : null;
      if (s.projectId) openStream(s.projectId);
      else closeStream();
      return;
    }
    if (s.project === prevProject) return;
    prevProject = s.project;
    // Server state, already true on both sides: nothing to push.
    if (applying) {
      base = s.project;
      return;
    }
    if (!s.projectId || !s.projectLoaded) return;
    const id = s.projectId;
    // A deliberate run-field change (Reopen, a chat session) must not sit in a
    // debounce where incoming server state would absorb it.
    if (base && runEdits(base, s.project).length > 0) {
      if (timer) clearTimeout(timer);
      timer = null;
      void push();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (useStore.getState().projectId !== id) return;
      void push();
    }, 1200);
  });
}
