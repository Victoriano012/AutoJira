import { Project, Ticket, TicketGraph, TicketStatus } from "./types";

/**
 * Single-writer discipline between the browser and the server process.
 *
 * Runs execute in the server, so the server is the only writer of the fields a
 * run produces — status, log, sessionId, resultSummary. The browser is the only
 * writer of everything else (titles, descriptions, types, positions, edges,
 * attachments, chat, board sessions, the ticket set itself).
 *
 * The browser still PUTs the whole project (autosave), so the server merges:
 * structure and user fields from the payload, run fields from its own state.
 * The two places where a person legitimately changes a run field — Reopen
 * (status → todo) and the side chat storing the session it opened — travel
 * separately as `RunEdit` intents, which the server applies unless a live run
 * owns that ticket.
 */

/** Run-produced fields, present on the ticket only when set. */
function runFields(t: Ticket): Partial<Ticket> {
  return {
    status: t.status,
    log: t.log,
    ...(t.sessionId !== undefined ? { sessionId: t.sessionId } : {}),
    ...(t.resultSummary !== undefined ? { resultSummary: t.resultSummary } : {}),
  };
}

function mergeGraph(edit: TicketGraph, run: TicketGraph): TicketGraph {
  return {
    ...edit,
    tickets: edit.tickets.map((t) => {
      const r = run.tickets.find((x) => x.id === t.id);
      // A ticket the run side has never seen keeps the editor's own values.
      if (!r) return t;
      return { ...t, ...runFields(r), subgraph: mergeGraph(t.subgraph, r.subgraph) };
    }),
  };
}

/** Structure and user edits from `edit`, run-produced fields from `run`. */
export function mergeRunState(edit: Project, run: Project): Project {
  return { ...edit, graph: mergeGraph(edit.graph, run.graph) };
}

/** A person's deliberate change to a run field, sent alongside an autosave. */
export interface RunEdit {
  path: string[];
  id: string;
  status?: TicketStatus;
  sessionId?: string;
}

/** Run-field changes the browser made on top of the last server snapshot. */
export function runEdits(base: Project, next: Project): RunEdit[] {
  const out: RunEdit[] = [];
  const walk = (path: string[], b: TicketGraph, n: TicketGraph) => {
    for (const t of n.tickets) {
      const prev = b.tickets.find((x) => x.id === t.id);
      if (!prev) continue; // brand new ticket: its status is not an edit
      const edit: RunEdit = { path, id: t.id };
      if (prev.status !== t.status) edit.status = t.status;
      if (t.sessionId !== undefined && prev.sessionId !== t.sessionId) {
        edit.sessionId = t.sessionId;
      }
      if (edit.status !== undefined || edit.sessionId !== undefined) out.push(edit);
      walk([...path, t.id], prev.subgraph, t.subgraph);
    }
  };
  walk([], base.graph, next.graph);
  return out;
}

/** Apply run-field intents, skipping tickets a live run owns. */
export function applyRunEdits(
  project: Project,
  edits: RunEdit[],
  owned: (path: string[], id: string) => boolean
): Project {
  let graph = project.graph;
  for (const e of edits) {
    if (owned(e.path, e.id)) continue;
    graph = rewrite(graph, e.path, (g) => ({
      ...g,
      tickets: g.tickets.map((t) =>
        t.id === e.id
          ? {
              ...t,
              ...(e.status !== undefined ? { status: e.status } : {}),
              ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
            }
          : t
      ),
    }));
  }
  return graph === project.graph ? project : { ...project, graph };
}

/** Immutably rewrite the graph at `path` (mirrors the browser store). */
export function rewrite(
  g: TicketGraph,
  path: string[],
  fn: (g: TicketGraph) => TicketGraph
): TicketGraph {
  if (path.length === 0) return fn(g);
  const [head, ...rest] = path;
  return {
    ...g,
    tickets: g.tickets.map((t) =>
      t.id === head ? { ...t, subgraph: rewrite(t.subgraph, rest, fn) } : t
    ),
  };
}
