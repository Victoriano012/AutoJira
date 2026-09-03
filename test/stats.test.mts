import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  addStats,
  collectStats,
  emptyStats,
  formatCost,
  formatDuration,
  formatTokens,
} from "../lib/stats.ts";
import type { Ticket, TicketStats } from "../lib/types.ts";

const t = (p: Partial<Ticket> & { id: string }): Ticket => ({
  title: p.id,
  description: "",
  status: "todo",
  log: [],
  ...p,
});
const s = (p: Partial<TicketStats>): TicketStats => ({ ...emptyStats(), ...p });

test("stats sum over the board", () => {
  const stats = collectStats([
    t({ id: "a", stats: s({ runs: 1, ms: 1000, tokens: 100, costUsd: 0.1 }) }),
    t({ id: "b", stats: s({ runs: 2, ms: 500, tokens: 50, costUsd: 0.05 }) }),
    t({ id: "c", stats: s({ runs: 1, ms: 250, tokens: 25 }) }),
    t({ id: "d" }),
  ]);
  assert.equal(stats.tickets, 4);
  assert.equal(stats.runs, 4);
  assert.equal(stats.ms, 1750);
  assert.equal(stats.tokens, 175);
  assert.equal(Math.round(stats.costUsd * 100) / 100, 0.15);
  // Only the three tickets that actually recorded something.
  assert.equal(stats.measured, 3);
});

test("nothing recorded stays distinguishable from zero", () => {
  const stats = collectStats([t({ id: "a" })]);
  assert.equal(stats.measured, 0);
  assert.equal(stats.ms, 0);
  assert.equal(stats.rejectionsPerReview, null);
});

test("statuses are counted", () => {
  const stats = collectStats([
    t({ id: "a", status: "done" }),
    t({ id: "b", status: "error" }),
    t({ id: "b1", status: "done" }),
    t({ id: "c", status: "review" }),
  ]);
  assert.deepEqual(stats.byStatus, { todo: 0, running: 0, review: 1, done: 2, error: 1 });
});

test("rejections average over reviewed tickets only", () => {
  const stats = collectStats([
    // Signed off with no rejection: reviewed, contributes 0.
    t({ id: "h1", status: "done" }),
    // Sent back twice and still in review: reviewed, contributes 2.
    t({ id: "h2", status: "review", stats: s({ rejections: 2 }) }),
    // Waiting on its person, never filed: not in the denominator.
    t({ id: "h3", status: "review" }),
  ]);
  assert.equal(stats.reviewed, 2);
  assert.equal(stats.rejections, 2);
  assert.equal(stats.rejectionsPerReview, 1);
});

test("no reviewed ticket means no average, not a division", () => {
  const stats = collectStats([t({ id: "h", status: "review" }), t({ id: "a" })]);
  assert.equal(stats.reviewed, 0);
  assert.equal(stats.rejectionsPerReview, null);
});

test("runs without a reported cost are tracked separately", () => {
  const stats = collectStats([
    t({ id: "a", stats: s({ runs: 1, tokens: 900, costUsd: 0.2 }) }),
    // A Codex run: tokens, no cost.
    t({ id: "b", stats: s({ runs: 2, tokens: 100, runsWithoutCost: 2 }) }),
  ]);
  assert.equal(stats.runs, 3);
  assert.equal(stats.runsWithoutCost, 2);
  assert.equal(stats.tokens, 1000);
});

test("addStats folds onto an absent total", () => {
  assert.deepEqual(addStats(undefined, { runs: 1, ms: 5 }), s({ runs: 1, ms: 5 }));
  assert.deepEqual(
    addStats(s({ runs: 1, ms: 5, rejections: 1 }), { rejections: 1 }),
    s({ runs: 1, ms: 5, rejections: 2 })
  );
});

test("numbers read as humans write them", () => {
  assert.equal(formatDuration(450), "450ms");
  assert.equal(formatDuration(9_500), "10s");
  assert.equal(formatDuration(95_000), "1m 35s");
  assert.equal(formatDuration(4_320_000), "1h 12m");
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(0.0042), "$0.0042");
  assert.equal(formatCost(0.42), "$0.42");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(12_345), "12.3k");
  assert.equal(formatTokens(2_500_000), "2.50M");
});
