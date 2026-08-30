export type TicketType = "ai" | "human_review";

export type TicketStatus = "todo" | "running" | "review" | "done" | "error";

export interface GraphEdge {
  id: string;
  source: string; // ticket id that must complete first
  target: string; // ticket id that depends on source
}

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  dataUrl: string; // data:<mediaType>;base64,…
}

export interface LogEntry {
  kind: "text" | "tool" | "user" | "error" | "info";
  text: string;
  ts: number;
}

export interface Ticket {
  id: string;
  title: string;
  description: string;
  type: TicketType;
  /** human_review only. false = non-blocking: dependents may start as soon as
   * the AI work is finished; the agent branches off in git so the human can
   * keep testing (and get fixes on) the review ticket's branch. Default true. */
  blocking?: boolean;
  status: TicketStatus;
  /** Context files inherited by everything in this ticket's subgraph. */
  attachments?: Attachment[];
  position: { x: number; y: number } | null;
  subgraph: TicketGraph;
  sessionId?: string; // Claude session, kept so review feedback resumes the same context
  /** human_review only: session of the board's request conversation, so every
   * bottom-bar request on this ticket's kanban board resumes the same chat. */
  boardSessionId?: string;
  log: LogEntry[];
  resultSummary?: string;
}

export interface TicketGraph {
  tickets: Ticket[];
  edges: GraphEdge[];
}

export interface Project {
  name: string;
  description: string;
  workspaceDir: string; // where the agent works; empty = server temp dir
  /** Project-wide context files, inherited by every ticket. */
  attachments?: Attachment[];
  /** Where this project's node sits on the meta-graph (project picker). */
  metaPosition?: { x: number; y: number };
  /** Hidden from the meta-graph; importing the folder again clears it. */
  hidden?: boolean;
  graph: TicketGraph;
}

export interface ContextLevel {
  title: string;
  description: string;
  attachments: Attachment[];
}

/** Inherited context along `path`: the project (level 0) plus every ancestor
 * ticket. Each level's description and attachments apply to everything below. */
export function contextChain(project: Project, path: string[]): ContextLevel[] {
  const levels: ContextLevel[] = [
    {
      title: project.name,
      description: project.description,
      attachments: project.attachments ?? [],
    },
  ];
  let g = project.graph;
  for (const id of path) {
    const t = g.tickets.find((t) => t.id === id);
    if (!t) break;
    levels.push({
      title: t.title,
      description: t.description,
      attachments: t.attachments ?? [],
    });
    g = t.subgraph;
  }
  return levels;
}

export const emptyGraph = (): TicketGraph => ({ tickets: [], edges: [] });

export const defaultProject = (name: string, workspaceDir = ""): Project => ({
  name,
  description: "",
  workspaceDir,
  attachments: [],
  graph: emptyGraph(),
});

export function newTicket(partial?: Partial<Ticket>): Ticket {
  return {
    id: crypto.randomUUID(),
    title: "New ticket",
    description: "",
    type: "ai",
    status: "todo",
    position: null,
    subgraph: emptyGraph(),
    log: [],
    ...partial,
  };
}

/** Follow a path of ticket ids into nested subgraphs. */
export function graphAtPath(root: TicketGraph, path: string[]): TicketGraph | null {
  let g: TicketGraph = root;
  for (const id of path) {
    const t = g.tickets.find((t) => t.id === id);
    if (!t) return null;
    g = t.subgraph;
  }
  return g;
}

export function ticketAtPath(
  root: TicketGraph,
  path: string[],
  ticketId: string
): Ticket | null {
  const g = graphAtPath(root, path);
  return g?.tickets.find((t) => t.id === ticketId) ?? null;
}

/** True if adding source->target would create a cycle. */
export function wouldCreateCycle(
  graph: TicketGraph,
  source: string,
  target: string
): boolean {
  if (source === target) return true;
  // cycle iff source is reachable from target
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  }
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(adj.get(cur) ?? []));
  }
  return false;
}

export function dependenciesOf(graph: TicketGraph, ticketId: string): Ticket[] {
  const depIds = graph.edges.filter((e) => e.target === ticketId).map((e) => e.source);
  return graph.tickets.filter((t) => depIds.includes(t.id));
}

/** A ticket is effectively done when its own status is done AND, if it has a
 * subgraph, every ticket inside is done too. */
export function isTicketDone(t: Ticket): boolean {
  if (t.subgraph.tickets.length > 0) return t.subgraph.tickets.every(isTicketDone);
  return t.status === "done";
}

/** Whether dependents of this ticket may start. Done always satisfies; a
 * non-blocking human-review ticket satisfies as soon as the AI work is
 * finished (status "review"), before the human approves. */
export function satisfiesDependents(t: Ticket): boolean {
  if (isTicketDone(t)) return true;
  return t.type === "human_review" && t.blocking === false && t.status === "review";
}

/** True if running the graph now could make progress somewhere inside. */
export function hasRunnableWork(g: TicketGraph): boolean {
  return g.tickets.some((t) => {
    if (isTicketDone(t)) return false;
    if (!dependenciesOf(g, t.id).every(satisfiesDependents)) return false;
    if (t.subgraph.tickets.length > 0) return hasRunnableWork(t.subgraph);
    return t.status === "todo";
  });
}

export function ticketProgress(t: Ticket): { done: number; total: number } | null {
  if (t.subgraph.tickets.length === 0) return null;
  return {
    done: t.subgraph.tickets.filter(isTicketDone).length,
    total: t.subgraph.tickets.length,
  };
}
