"use client";

import { useStore } from "./store";
import { emptyGraph, Project } from "./types";

const defaultProject = (name: string): Project => ({
  name,
  description: "",
  workspaceDir: "",
  attachments: [],
  graph: emptyGraph(),
});

export async function createProject(name: string): Promise<string> {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data: defaultProject(name) }),
  });
  if (!res.ok) throw new Error(`Create failed (${res.status})`);
  const row = await res.json();
  useStore.getState().openProject(row.id, defaultProject(name));
  return row.id;
}

export async function openProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${id}`);
  if (!res.ok) {
    // deleted or someone else's — forget it
    useStore.getState().closeProject();
    return;
  }
  const row = await res.json();
  const data = row.data ?? {};
  useStore.getState().openProject(id, {
    ...defaultProject(row.name),
    ...data,
  });
}

export async function deleteProject(id: string): Promise<void> {
  await fetch(`/api/projects/${id}`, { method: "DELETE" });
}

// ---- autosave ----------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/** Debounced push of the open project to the server on every store change. */
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
      void fetch(`/api/projects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: project.name, data: project }),
      });
    }, 1200);
  });
}
