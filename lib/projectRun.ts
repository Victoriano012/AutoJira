"use client";

import { isGraphRunning, runGraph, stopGraph } from "./runner";
import { openProject } from "./sync";

// The runner (and the store it drives) hold a single project, so at most one
// project run exists at a time; remember whose it is so the meta-graph can
// show it when the user navigates back to the picker mid-run.
let runningId: string | null = null;

/** ▶ on a project node: open the project and run its whole graph from root. */
export async function runProject(id: string): Promise<void> {
  await openProject(id);
  runningId = id;
  try {
    await runGraph([]);
  } finally {
    if (runningId === id && !isGraphRunning([])) runningId = null;
  }
}

/** True while the run started from this project's node is still active
 * (including waiting on human reviews). */
export function isProjectRunning(id: string): boolean {
  if (runningId !== id) return false;
  if (isGraphRunning([])) return true;
  runningId = null;
  return false;
}

export function stopProject(id: string): void {
  if (runningId !== id) return;
  stopGraph([]);
  runningId = null;
}
