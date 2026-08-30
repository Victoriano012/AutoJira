"use client";

import { useStore } from "./store";

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

// ---- autosave ----------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/** Debounced push of the open project to its .autojira dir on every change. */
export function startAutosave(): void {
  if (started) return;
  started = true;
  let prev = useStore.getState().project;
  useStore.subscribe((s) => {
    if (s.project === prev) return;
    prev = s.project;
    if (!s.projectId || !s.projectLoaded) return;
    const id = s.projectId;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const { project, projectId } = useStore.getState();
      if (projectId !== id) return;
      void fetch(`/api/projects/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: project }),
      });
    }, 1200);
  });
}
