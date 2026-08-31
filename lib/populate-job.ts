"use client";

/**
 * The one "populate with AI" request in flight, outliving its modal.
 *
 * Generating a graph takes a minute, and the modal used to hold the person
 * there watching a spinner. Now submitting closes the modal and the toolbar
 * shows the job the way it shows a run — so the request, its AbortController
 * and the path it was asked for have to live somewhere the modal's unmount
 * can't take with it. That is here.
 *
 * The result comes back with no modal to land in, so it is parked in `result`
 * and the toolbar reopens the modal on it: either to ask before replacing
 * tickets that are already there, or to show the error with the description
 * still typed in. Applying to an empty graph needs nobody, so it just happens.
 *
 * In memory only: a reload loses an in-flight populate, deliberately.
 */

import { autoLayout } from "./layout";
import { useStore } from "./store";
import {
  GraphEdge,
  graphAtPath,
  newTicket,
  Ticket,
  TicketGraph,
  TicketType,
} from "./types";

/** The parts of the request only the modal can build (it has the context
 * chain and the attachments of the level being described). */
export interface PopulateRequest {
  description: string;
  chain: { title: string; description: string }[];
  attachments: { name: string; dataUrl: string }[];
}

/** A landed populate that still needs the person: a graph waiting for the
 * "replace what's there?" confirmation, or an error to show them. */
export interface PopulateResult {
  path: string[];
  description: string;
  graph?: TicketGraph;
  error?: string;
}

export interface PopulateState {
  /** pathKey of the graph being populated, or null when nothing is in flight. */
  populating: string | null;
  result: PopulateResult | null;
}

interface GeneratedTicket {
  title: string;
  description: string;
  type: TicketType;
  dependsOn: number[];
}

interface Singleton {
  state: PopulateState;
  pending: { path: string[]; controller: AbortController } | null;
  listeners: Set<() => void>;
}

// On `window`, for the reason the store is (see the note in `lib/store.ts`):
// `next dev` re-evaluates this module constantly, and the toolbar reading the
// job has to be looking at the same object the running fetch writes to — two
// copies would look like the spinner never starting, or never stopping.
const win =
  typeof window === "undefined"
    ? null
    : (window as unknown as { __autoprojectPopulate?: Singleton });
const S: Singleton = win?.__autoprojectPopulate ?? {
  state: { populating: null, result: null },
  pending: null,
  listeners: new Set(),
};
if (win) win.__autoprojectPopulate = S;

const pathKey = (path: string[]) => path.join("/") || "(root)";

/** Subscribe to populate-job changes (the toolbar); returns the unsubscribe. */
export function subscribePopulate(fn: () => void): () => void {
  S.listeners.add(fn);
  return () => {
    S.listeners.delete(fn);
  };
}

export function populateState(): PopulateState {
  return S.state;
}

function set(next: Partial<PopulateState>): void {
  S.state = { ...S.state, ...next };
  for (const fn of [...S.listeners]) fn();
}

/** In flight at all, or — given a path — in flight for that graph. */
export function isPopulating(path?: string[]): boolean {
  return path ? S.state.populating === pathKey(path) : S.state.populating !== null;
}

/** The violet stop: discard the job silently, like closing the modal did. */
export function abortPopulate(): void {
  S.pending?.controller.abort();
}

export function clearPopulateResult(): void {
  set({ result: null });
}

/** Write a generated graph into the project at the path it was asked for. */
export function applyPopulated(
  path: string[],
  description: string,
  graph: TicketGraph
): void {
  const store = useStore.getState();
  store.updateGraph(path, () => graph);
  if (path.length === 0) store.setProject({ description });
  clearPopulateResult();
}

/** Start the one populate. A second call while one is in flight is a no-op —
 * the toolbar's ✨ is disabled then, so this only guards a race. */
export async function startPopulate(
  path: string[],
  req: PopulateRequest
): Promise<void> {
  if (S.pending) return;
  const controller = new AbortController();
  S.pending = { path, controller };
  set({ populating: pathKey(path), result: null });
  try {
    const res = await fetch("/api/populate", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `Request failed (${res.status})`);
    }
    const data = (await res.json()) as { tickets: GeneratedTicket[] };

    const tickets: Ticket[] = data.tickets.map((g) =>
      newTicket({ title: g.title, description: g.description, type: g.type })
    );
    const edges: GraphEdge[] = [];
    data.tickets.forEach((g, i) => {
      for (const d of g.dependsOn) {
        if (d !== i && tickets[d]) {
          edges.push({
            id: crypto.randomUUID(),
            source: tickets[d].id,
            target: tickets[i].id,
          });
        }
      }
    });
    const graph = { tickets, edges };
    const positions = autoLayout(graph);
    for (const t of tickets) t.position = positions.get(t.id) ?? null;

    const existing = graphAtPath(useStore.getState().project.graph, path);
    if (existing && existing.tickets.length > 0) {
      set({ result: { path, description: req.description, graph } });
      return;
    }
    applyPopulated(path, req.description, graph);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    set({
      result: {
        path,
        description: req.description,
        error: String(err instanceof Error ? err.message : err),
      },
    });
  } finally {
    S.pending = null;
    set({ populating: null });
  }
}
