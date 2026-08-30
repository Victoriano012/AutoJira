"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  emptyGraph,
  GraphEdge,
  LogEntry,
  Project,
  Ticket,
  TicketGraph,
} from "./types";

interface AppState {
  project: Project;
  path: string[]; // ticket ids from root to the currently open subgraph
  selectedId: string | null;

  setProject: (p: Partial<Project>) => void;
  setPath: (path: string[]) => void;
  select: (id: string | null) => void;

  /** Immutably rewrite the graph at `path`. */
  updateGraph: (path: string[], fn: (g: TicketGraph) => TicketGraph) => void;
  updateTicket: (path: string[], id: string, fn: (t: Ticket) => Ticket) => void;

  addTicket: (path: string[], t: Ticket) => void;
  removeTicket: (path: string[], id: string) => void;
  addEdge: (path: string[], e: GraphEdge) => void;
  removeEdge: (path: string[], edgeId: string) => void;
  appendLog: (path: string[], id: string, entry: LogEntry) => void;
}

function rewriteAt(
  g: TicketGraph,
  path: string[],
  fn: (g: TicketGraph) => TicketGraph
): TicketGraph {
  if (path.length === 0) return fn(g);
  const [head, ...rest] = path;
  return {
    ...g,
    tickets: g.tickets.map((t) =>
      t.id === head ? { ...t, subgraph: rewriteAt(t.subgraph, rest, fn) } : t
    ),
  };
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      project: {
        name: "Untitled project",
        description: "",
        workspaceDir: "",
        attachments: [],
        graph: emptyGraph(),
      },
      path: [],
      selectedId: null,

      setProject: (p) => set((s) => ({ project: { ...s.project, ...p } })),
      setPath: (path) => set({ path, selectedId: null }),
      select: (id) => set({ selectedId: id }),

      updateGraph: (path, fn) =>
        set((s) => ({
          project: { ...s.project, graph: rewriteAt(s.project.graph, path, fn) },
        })),

      updateTicket: (path, id, fn) =>
        set((s) => ({
          project: {
            ...s.project,
            graph: rewriteAt(s.project.graph, path, (g) => ({
              ...g,
              tickets: g.tickets.map((t) => (t.id === id ? fn(t) : t)),
            })),
          },
        })),

      addTicket: (path, t) =>
        set((s) => ({
          project: {
            ...s.project,
            graph: rewriteAt(s.project.graph, path, (g) => ({
              ...g,
              tickets: [...g.tickets, t],
            })),
          },
        })),

      removeTicket: (path, id) =>
        set((s) => ({
          selectedId: s.selectedId === id ? null : s.selectedId,
          project: {
            ...s.project,
            graph: rewriteAt(s.project.graph, path, (g) => ({
              tickets: g.tickets.filter((t) => t.id !== id),
              edges: g.edges.filter((e) => e.source !== id && e.target !== id),
            })),
          },
        })),

      addEdge: (path, e) =>
        set((s) => ({
          project: {
            ...s.project,
            graph: rewriteAt(s.project.graph, path, (g) =>
              g.edges.some(
                (x) => x.source === e.source && x.target === e.target
              )
                ? g
                : { ...g, edges: [...g.edges, e] }
            ),
          },
        })),

      removeEdge: (path, edgeId) =>
        set((s) => ({
          project: {
            ...s.project,
            graph: rewriteAt(s.project.graph, path, (g) => ({
              ...g,
              edges: g.edges.filter((e) => e.id !== edgeId),
            })),
          },
        })),

      appendLog: (path, id, entry) =>
        set((s) => ({
          project: {
            ...s.project,
            graph: rewriteAt(s.project.graph, path, (g) => ({
              ...g,
              tickets: g.tickets.map((t) =>
                t.id === id ? { ...t, log: [...t.log, entry] } : t
              ),
            })),
          },
        })),
    }),
    { name: "autojira-project" }
  )
);
