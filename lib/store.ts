"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  emptyGraph,
  graphAtPath,
  GraphEdge,
  LogEntry,
  Project,
  Ticket,
  TicketGraph,
} from "./types";

interface AppState {
  /** Server id of the open project; null = show the project picker. */
  projectId: string | null;
  /** True once the open project's data has been fetched from the server. */
  projectLoaded: boolean;
  project: Project;
  path: string[]; // ticket ids from root to the currently open subgraph
  selectedId: string | null;
  chatOpen: boolean;

  openProject: (id: string, project: Project) => void;
  closeProject: () => void;
  setProject: (p: Partial<Project>) => void;
  setPath: (path: string[]) => void;
  select: (id: string | null) => void;
  toggleChat: () => void;

  /** Immutably rewrite the graph at `path`. */
  updateGraph: (path: string[], fn: (g: TicketGraph) => TicketGraph) => void;
  updateTicket: (path: string[], id: string, fn: (t: Ticket) => Ticket) => void;

  addTicket: (path: string[], t: Ticket) => void;
  removeTicket: (path: string[], id: string) => void;
  addEdge: (path: string[], e: GraphEdge) => void;
  removeEdge: (path: string[], edgeId: string) => void;
  appendLog: (path: string[], id: string, entry: LogEntry) => void;
}

/** Cards on a human ticket's kanban board are always leaves: a person's review
 * must never hide another board inside it. Every graph edit passes through
 * `rewriteAt`, so the invariant is enforced there — where a subgraph would be
 * created — rather than by hiding buttons in whichever UI could reach it. */
function asBoard(g: TicketGraph): TicketGraph {
  if (!g.tickets.some((t) => t.subgraph.tickets.length > 0)) return g;
  return {
    ...g,
    tickets: g.tickets.map((t) =>
      t.subgraph.tickets.length > 0 ? { ...t, subgraph: emptyGraph() } : t
    ),
  };
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
    tickets: g.tickets.map((t) => {
      if (t.id !== head) return t;
      // A human ticket's subgraph is its kanban board (see `asBoard`): a write
      // aimed *inside* one of its cards is dropped, and a write to the board
      // itself is normalised, so no edit can ever nest a board in a card.
      const board = t.type === "human_review";
      if (board && rest.length > 0) return t;
      const subgraph = rewriteAt(t.subgraph, rest, fn);
      return { ...t, subgraph: board ? asBoard(subgraph) : subgraph };
    }),
  };
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      projectId: null,
      projectLoaded: false,
      project: {
        name: "Untitled project",
        description: "",
        workspaceDir: "",
        attachments: [],
        graph: emptyGraph(),
      },
      path: [],
      selectedId: null,
      chatOpen: false,

      // Re-opening the project the browser is already in — a reload, or a dev
      // HMR update that re-creates this module — must not cost the person the
      // subgraph they were standing in. Keep `path` when it still resolves in
      // the graph the server just handed us; only a genuinely gone ticket
      // sends them back to the root.
      openProject: (id, project) =>
        set((s) => {
          const g = s.projectId === id ? graphAtPath(project.graph, s.path) : null;
          return {
            projectId: id,
            projectLoaded: true,
            project,
            path: g ? s.path : [],
            selectedId:
              g && s.selectedId && g.tickets.some((t) => t.id === s.selectedId)
                ? s.selectedId
                : null,
          };
        }),
      closeProject: () => set({ projectId: null, projectLoaded: false, path: [], selectedId: null }),
      setProject: (p) => set((s) => ({ project: { ...s.project, ...p } })),
      setPath: (path) => set({ path, selectedId: null }),
      // The ticket panel and the chat drawer share the same space — only one open at a time.
      select: (id) => set((s) => ({ selectedId: id, chatOpen: id === null ? s.chatOpen : false })),
      toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen, selectedId: s.chatOpen ? s.selectedId : null })),

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
    {
      name: "autojira-project",
      // Project data lives on the server; only remember which project is open
      // and where inside it the person was — `openProject` re-validates that
      // path against the graph it fetches before restoring it.
      partialize: (s) => ({
        projectId: s.projectId,
        path: s.path,
        selectedId: s.selectedId,
      }),
    }
  )
);
