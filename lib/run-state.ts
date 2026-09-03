import type { Project, Ticket, TicketStatus } from "./types";

/**
 * Single-writer discipline between the browser and the server process.
 *
 * Runs execute in the server, so the server is the only writer of the fields a
 * run produces — status, log, sessionId, resultSummary, stats — and, since the
 * project agent adds and removes tickets there too, of the ticket set itself
 * and of its own conversation. The browser is the only writer of the user
 * fields (titles, descriptions, files, attachments, paused, notes).
 *
 * The browser still PUTs the whole project (autosave), so the server merges:
 * user fields from the payload, ticket set and run fields from its own state.
 * The one place where a person legitimately changes a run field — Reopen
 * (status → todo) — travels separately as a `RunEdit` intent, which the server
 * applies unless a live run owns that ticket.
 */

/** Run-produced fields, present on the ticket only when set. */
function runFields(t: Ticket): Partial<Ticket> {
  return {
    status: t.status,
    log: t.log,
    ...(t.statusChangedAt !== undefined ? { statusChangedAt: t.statusChangedAt } : {}),
    ...(t.sessionId !== undefined ? { sessionId: t.sessionId } : {}),
    ...(t.resultSummary !== undefined ? { resultSummary: t.resultSummary } : {}),
    ...(t.stats !== undefined ? { stats: t.stats } : {}),
  };
}

/** Server-owned project-level fields. */
function projectRunFields(p: Project): Partial<Project> {
  return {
    chat: p.chat,
    ...(p.agentSessionId !== undefined ? { agentSessionId: p.agentSessionId } : {}),
  };
}

/** Ticket set and run fields from `run` (the server); user fields from `edit`
 * where the browser knows the ticket. */
export function mergeRunState(edit: Project, run: Project): Project {
  const tickets = run.tickets.map((r) => {
    const e = edit.tickets.find((x) => x.id === r.id);
    return e ? { ...e, ...runFields(r) } : r;
  });
  if (process.env.NODE_ENV !== "production") {
    // A ticket only the browser knows is one the server has since removed (or
    // never had): a stale tab. Its edits are dropped, which is worth knowing.
    const unknown = edit.tickets.filter((t) => !run.tickets.some((r) => r.id === t.id));
    if (unknown.length > 0) {
      console.warn(
        `mergeRunState dropped ${unknown.length} ticket(s) the server does not know: ` +
          unknown.map((t) => t.id).join(", ")
      );
    }
  }
  return { ...edit, ...projectRunFields(run), tickets };
}

/** A person's deliberate change to a run field, sent alongside an autosave. */
export interface RunEdit {
  id: string;
  status?: TicketStatus;
}

/** Status changes the browser made on top of the last server snapshot. */
export function runEdits(base: Project, next: Project): RunEdit[] {
  const out: RunEdit[] = [];
  for (const t of next.tickets) {
    const prev = base.tickets.find((x) => x.id === t.id);
    if (!prev) continue; // brand new ticket: its status is not an edit
    if (prev.status !== t.status) out.push({ id: t.id, status: t.status });
  }
  return out;
}

/** Apply run-field intents, skipping tickets a live run owns. */
export function applyRunEdits(
  project: Project,
  edits: RunEdit[],
  owned: (id: string) => boolean
): Project {
  let tickets = project.tickets;
  for (const e of edits) {
    const status = e.status;
    if (status === undefined || owned(e.id)) continue;
    tickets = tickets.map((t) =>
      t.id === e.id && t.status !== status
        ? { ...t, status, statusChangedAt: Date.now() }
        : t
    );
  }
  return tickets === project.tickets ? project : { ...project, tickets };
}
