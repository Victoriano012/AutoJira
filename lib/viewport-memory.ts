"use client";

/**
 * Where each graph was left, for as long as the page is open.
 *
 * Drilling into a ticket unmounts the graph behind it, and a graph mounts
 * fitted — so coming back used to throw away the pan and zoom the person had
 * just arranged and drop them somewhere else. Every graph the app shows keeps
 * its own entry here (the project's root, each subgraph, the meta-graph), and
 * a returning canvas starts from it instead of re-fitting.
 *
 * In memory only, deliberately: a reload or a fresh tab starts fitted again.
 * Nothing here is persisted — not to localStorage, not to project.json.
 *
 * Recorded from React Flow's `onMoveEnd`, not when the canvas goes away: the
 * flow's store is reset by its own unmount effect (`StoreUpdater`'s cleanup)
 * before a child's cleanup gets to run, so a read taken then is 0,0,1 — which
 * looked exactly like the memory doing nothing at all.
 */

import type { Viewport } from "@xyflow/react";

// On `window`, for the reason the store is (see the note in `lib/store.ts`):
// `next dev` re-evaluates this module constantly, and the canvas that recorded
// a viewport and the fresh import that reads it back have to be looking at the
// same map — two copies would just look like the memory not working.
const win =
  typeof window === "undefined"
    ? null
    : (window as unknown as { __autoprojectViewports?: Map<string, Viewport> });
const S: Map<string, Viewport> = win?.__autoprojectViewports ?? new Map();
if (win) win.__autoprojectViewports = S;

/** The project picker's graph of projects — one per page, above any project. */
export const META_GRAPH_KEY = "meta";

export function rememberViewport(key: string, v: Viewport): void {
  S.set(key, v);
}

/** Where this graph was left, or undefined the first time it is opened — then
 * `fitView` still has it. Read once per mount at the call sites: the value is
 * rewritten as the person pans, so a re-read is the position being left. */
export function rememberedViewport(key: string): Viewport | undefined {
  return S.get(key);
}
