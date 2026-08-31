/** "subgraph" is a label for tickets whose work is decomposed into a nested
 * graph; execution still keys off whether a subgraph is actually present. */
export type TicketType = "ai" | "human_review" | "subgraph";

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
  /** Nested tickets. A human_review ticket's subgraph is its kanban board, and
   * the cards on it are always leaves: a review must never hide another board
   * inside it, so nothing may give a card a subgraph (enforced in the store's
   * rewriteAt, which every graph edit goes through). */
  subgraph: TicketGraph;
  sessionId?: string; // Claude session, kept so review feedback resumes the same context
  /** Side chat with this ticket's main agent — the conversation resumes
   * sessionId, so the agent already knows the work it did for the ticket. */
  chat?: ChatMessage[];
  /** human_review only: session of the board's request conversation, so every
   * bottom-bar request on this ticket's kanban board resumes the same chat. */
  boardSessionId?: string;
  log: LogEntry[];
  resultSummary?: string;
  /** Stopped by the person, not by dependencies: it stays out of the queue and
   * shows a Run button until they start it again. */
  paused?: boolean;
  /** Workspace-relative paths this ticket expects to touch. Two tickets in the
   * same graph that share a file are never run at the same time (see
   * `fileBlockedBy`) — file contention is computed from this list, never turned
   * into a dependency edge. */
  files?: string[];
}

export interface TicketGraph {
  tickets: Ticket[];
  edges: GraphEdge[];
}

export interface ChatMessage {
  role: "user" | "agent";
  text: string;
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
  /** The root level's side chat — a project is just the outermost "ticket",
   * so these mirror a ticket's sessionId + chat. */
  chatSessionId?: string;
  chat?: ChatMessage[];
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
    paused: false,
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

/** The reverse of dependenciesOf: tickets that depend on this one. */
export function dependentsOf(graph: TicketGraph, ticketId: string): Ticket[] {
  const depIds = graph.edges.filter((e) => e.source === ticketId).map((e) => e.target);
  return graph.tickets.filter((t) => depIds.includes(t.id));
}

/** A ticket is effectively done when its own status is done AND, if it has a
 * subgraph, every ticket inside is done too — except a human ticket, which is
 * only ever finished by its person ("All good" on the board, "Mark done" in the
 * panel). Every card on its board being Done means there is nothing left to
 * review, not that the review happened. */
export function isTicketDone(t: Ticket): boolean {
  if (t.type === "human_review") return t.status === "done";
  if (t.subgraph.tickets.length > 0) return t.subgraph.tickets.every(isTicketDone);
  return t.status === "done";
}

/** Whether dependents of this ticket may start. Done always satisfies; a
 * non-blocking human-review ticket satisfies as soon as the AI work under it is
 * finished — a leaf when it reaches "review", a board when every card is done —
 * without waiting for the human's approval. */
export function satisfiesDependents(t: Ticket): boolean {
  if (isTicketDone(t)) return true;
  if (t.type !== "human_review" || t.blocking !== false) return false;
  return t.subgraph.tickets.length > 0
    ? t.subgraph.tickets.every(isTicketDone)
    : t.status === "review";
}

/** An agent is genuinely at work at or beneath this ticket. A ticket with a
 * subgraph carries "running" only as bookkeeping while its scheduler drives
 * that subgraph (and keeps carrying it if the run dies with a reload), so what
 * counts is whether a leaf inside is running — at any depth. */
export function isTicketRunning(t: Ticket): boolean {
  if (t.subgraph.tickets.length > 0) return t.subgraph.tickets.some(isTicketRunning);
  return t.status === "running";
}

/** Waiting on a human, not actually running: the graph is blocked here and
 * only a person can move it on. `depsSatisfied` says whether everything this
 * ticket depends on is satisfied in its containing graph — a ticket still
 * blocked on an unmet dependency is not waiting on anyone, it just has not
 * started.
 * - A leaf human ticket is Waiting once the runner has handed it over (status
 *   review); a chat the human starts on it runs a real agent, so it is Running
 *   then, and stale "running" never survives a load (see settleZombies).
 * - A human ticket with a board is Running only while some card is genuinely
 *   running in the Working column; otherwise it is Waiting for the human to
 *   complete it — a board with every card Done included, since only "All good"
 *   ends the review.
 * - Any other ticket is Waiting only when something inside it is itself
 *   Waiting; subtickets merely blocked on dependencies do not count. */
export function isTicketWaiting(t: Ticket, depsSatisfied: boolean): boolean {
  if (isTicketDone(t) || isTicketRunning(t) || !depsSatisfied) return false;
  const g = t.subgraph;
  if (g.tickets.length === 0)
    return t.type === "human_review" && t.status === "review";
  // Nothing is genuinely running inside (checked above), so an unfinished
  // board is waiting on its human.
  if (t.type === "human_review") return true;
  return g.tickets.some((s) =>
    isTicketWaiting(s, dependenciesOf(g, s.id).every(satisfiesDependents))
  );
}

/** The same file named two ways ("./src/a.ts", "src/a.ts") is one file. */
const normFile = (f: string) => f.trim().replace(/^\.?\//, "");

/**
 * Why this ticket cannot start: another ticket in the same graph is going to
 * touch one of its files. Two agents must never edit one file at once, so the
 * second ticket waits — computed from the files each ticket declares, never
 * stored as a dependency, so the graph draws no edge for it.
 *
 * A ticket holds its files only while it is still going to work on them: once
 * it reaches review the agent has stopped, so the next ticket takes the file
 * without waiting for the person to approve anything. (Sending a ticket in
 * review back with feedback makes it claim its files again, and it then waits
 * its turn like anything else — see `sendFeedback`.) Order settles who goes
 * first — earlier in the graph wins — except that a ticket already running
 * holds its files whatever the order.
 */
export interface FileClaim {
  /** The one file shown for this pair — the same on both cards. */
  file: string;
  /** Every file the two tickets share, sorted. */
  files: string[];
  /** The ticket holding them. */
  by: Ticket;
}

export function fileClaims(g: TicketGraph, ticketId: string): FileClaim[] {
  const i = g.tickets.findIndex((t) => t.id === ticketId);
  if (i < 0) return [];
  const me = g.tickets[i];
  // A ticket that has stopped working wants nothing: it is not waiting, and
  // nobody is waiting on its behalf.
  if (isTicketDone(me) || me.status === "review") return [];
  const mine = new Set((me.files ?? []).map(normFile));
  if (mine.size === 0) return [];
  const out: FileClaim[] = [];
  for (let j = 0; j < g.tickets.length; j++) {
    const o = g.tickets[j];
    if (j === i || isTicketDone(o) || o.status === "review") continue;
    if (!o.files?.length) continue;
    if (j > i && o.status !== "running") continue;
    // One claim per ticket, not per file: three shared files are still one
    // reason to wait. Sorted so both cards name the same one.
    const files = [...new Set(o.files.map(normFile))].filter((f) => mine.has(f)).sort();
    if (files.length) out.push({ file: files[0], files, by: o });
  }
  return out;
}

/** The first thing in this ticket's way, or null — the readiness predicate. */
export function fileBlockedBy(
  g: TicketGraph,
  ticketId: string
): { file: string; by: Ticket } | null {
  return fileClaims(g, ticketId)[0] ?? null;
}

/** The mirror of `fileClaims`: the tickets waiting on files this one holds —
 * what a working card shows to say why the rest of the board is waiting. A
 * file nobody else wants is not listed: holding it costs no one anything. */
export function fileBlockees(
  g: TicketGraph,
  ticketId: string
): { file: string; files: string[]; who: Ticket }[] {
  const out: { file: string; files: string[]; who: Ticket }[] = [];
  for (const o of g.tickets) {
    if (o.id === ticketId) continue;
    for (const claim of fileClaims(g, o.id)) {
      if (claim.by.id === ticketId) {
        out.push({ file: claim.file, files: claim.files, who: o });
      }
    }
  }
  return out;
}

/** True if running the graph now could make progress somewhere inside.
 * Paused and file-blocked tickets do not count: the scheduler will not dispatch
 * them, and a parent that thought otherwise would re-enter this graph forever. */
export function hasRunnableWork(g: TicketGraph): boolean {
  return g.tickets.some((t) => {
    if (isTicketDone(t) || t.paused) return false;
    if (!dependenciesOf(g, t.id).every(satisfiesDependents)) return false;
    if (t.subgraph.tickets.length > 0) return hasRunnableWork(t.subgraph);
    return t.status === "todo" && !fileBlockedBy(g, t.id);
  });
}

export function ticketProgress(t: Ticket): { done: number; total: number } | null {
  if (t.subgraph.tickets.length === 0) return null;
  return {
    done: t.subgraph.tickets.filter(isTicketDone).length,
    total: t.subgraph.tickets.length,
  };
}
