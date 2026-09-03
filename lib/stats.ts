import type { Ticket, TicketStats, TicketStatus } from "./types";

/**
 * Project statistics, summed over the board.
 *
 * Every total here is measured, never modelled: time is wall-clock around the
 * agent session, tokens and cost are what the provider reported, rejections are
 * counted as the person makes them. Runs made before those totals existed carry
 * no stats at all, so `measured` says how many tickets the numbers actually
 * come from — a panel showing 0 for a project that recorded nothing would be
 * claiming a measurement nobody took.
 */
export interface ProjectStats {
  tickets: number;
  byStatus: Record<TicketStatus, number>;
  /** Tickets carrying recorded stats; 0 means nothing below was measured. */
  measured: number;
  runs: number;
  ms: number;
  tokens: number;
  costUsd: number;
  /** Runs whose provider reported no cost (Codex never does), so `costUsd`
   * covers `runs - runsWithoutCost` of them. */
  runsWithoutCost: number;
  rejections: number;
  /** Tickets a person has actually reviewed — approved, or sent back at least
   * once. The denominator below. */
  reviewed: number;
  /** null when no ticket has been reviewed yet, rather than a division by zero. */
  rejectionsPerReview: number | null;
}

const zeroStatus = (): Record<TicketStatus, number> => ({
  todo: 0,
  running: 0,
  review: 0,
  done: 0,
  error: 0,
});

export const emptyStats = (): TicketStats => ({
  runs: 0,
  ms: 0,
  tokens: 0,
  costUsd: 0,
  runsWithoutCost: 0,
  rejections: 0,
});

/** Fold one session's (or one rejection's) numbers into a ticket's totals. */
export function addStats(
  base: TicketStats | undefined,
  add: Partial<TicketStats>
): TicketStats {
  const cur = base ?? emptyStats();
  return {
    runs: cur.runs + (add.runs ?? 0),
    ms: cur.ms + (add.ms ?? 0),
    tokens: cur.tokens + (add.tokens ?? 0),
    costUsd: cur.costUsd + (add.costUsd ?? 0),
    runsWithoutCost: cur.runsWithoutCost + (add.runsWithoutCost ?? 0),
    rejections: cur.rejections + (add.rejections ?? 0),
  };
}

/** A ticket the person has passed judgement on: they signed it off or sent it
 * back. One still sitting in review has not been reviewed yet. */
function isReviewed(t: Ticket): boolean {
  return t.status === "done" || (t.stats?.rejections ?? 0) > 0;
}

export function collectStats(tickets: Ticket[]): ProjectStats {
  const out: ProjectStats = {
    tickets: 0,
    byStatus: zeroStatus(),
    measured: 0,
    runs: 0,
    ms: 0,
    tokens: 0,
    costUsd: 0,
    runsWithoutCost: 0,
    rejections: 0,
    reviewed: 0,
    rejectionsPerReview: null,
  };

  for (const t of tickets) {
    out.tickets++;
    if (isReviewed(t)) out.reviewed++;
    out.byStatus[t.status]++;
    const s = t.stats;
    if (s) {
      out.measured++;
      out.runs += s.runs;
      out.ms += s.ms;
      out.tokens += s.tokens;
      out.costUsd += s.costUsd;
      out.runsWithoutCost += s.runsWithoutCost;
      out.rejections += s.rejections;
    }
  }

  if (out.reviewed > 0) out.rejectionsPerReview = out.rejections / out.reviewed;
  return out;
}

// ---- human-readable numbers ----------------------------------------------

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
