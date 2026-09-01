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
import type { Ticket, TicketGraph, TicketStats } from "../lib/types.ts";

const t = (p: Partial<Ticket> & { id: string }): Ticket => ({
  title: p.id,
  description: "",
  type: "ai",
  status: "todo",
  position: null,
  subgraph: { tickets: [], edges: [] },
  log: [],
  ...p,
});
const g = (tickets: Ticket[]): TicketGraph => ({ tickets, edges: [] });
const s = (p: Partial<TicketStats>): TicketStats => ({ ...emptyStats(), ...p });

test("stats sum through nested subgraphs", () => {
  const stats = collectStats(
    g([
      t({
        id: "a",
        stats: s({ runs: 1, ms: 1000, tokens: 100, costUsd: 0.1 }),
        subgraph: g([
          t({ id: "a1", stats: s({ runs: 2, ms: 500, tokens: 50, costUsd: 0.05 }) }),
          t({
            id: "a2",
            subgraph: g([t({ id: "a2x", stats: s({ runs: 1, ms: 250, tokens: 25 }) })]),
          }),
        ]),
      }),
      t({ id: "b" }),
    ])
  );
  assert.equal(stats.tickets, 5);
  assert.equal(stats.runs, 4);
  assert.equal(stats.ms, 1750);
  assert.equal(stats.tokens, 175);
  assert.equal(Math.round(stats.costUsd * 100) / 100, 0.15);
  // Only the three tickets that actually recorded something.
  assert.equal(stats.measured, 3);
});

test("nothing recorded stays distinguishable from zero", () => {
  const stats = collectStats(g([t({ id: "a", status: "done" })]));
  assert.equal(stats.measured, 0);
  assert.equal(stats.ms, 0);
  assert.equal(stats.rejectionsPerInteraction, null);
});

test("interaction tickets are counted apart from ai tickets", () => {
  const stats = collectStats(
    g([
      t({ id: "a" }),
      t({ id: "h", type: "human_review" }),
      t({ id: "p", type: "subgraph", subgraph: g([t({ id: "c" })]) }),
    ])
  );
  assert.equal(stats.interaction, 1);
  // "subgraph" is a label for decomposed agent work, so it counts as ai.
  assert.equal(stats.ai, 3);
  assert.equal(stats.tickets, 4);
});

test("statuses are counted per level and below", () => {
  const stats = collectStats(
    g([
      t({ id: "a", status: "done" }),
      t({ id: "b", status: "error", subgraph: g([t({ id: "b1", status: "done" })]) }),
      t({ id: "c", status: "review" }),
    ])
  );
  assert.deepEqual(stats.byStatus, { todo: 0, running: 0, review: 1, done: 2, error: 1 });
});

test("rejections average over reviewed interaction tickets only", () => {
  const stats = collectStats(
    g([
      // Signed off with no rejection: reviewed, contributes 0.
      t({ id: "h1", type: "human_review", status: "done" }),
      // Sent back twice and still in review: reviewed, contributes 2.
      t({
        id: "h2",
        type: "human_review",
        status: "review",
        stats: s({ rejections: 2 }),
      }),
      // Waiting on its person, never filed: not in the denominator.
      t({ id: "h3", type: "human_review", status: "review" }),
      // An ai ticket's rejection still counts in the total.
      t({ id: "a", status: "done", stats: s({ rejections: 1 }) }),
    ])
  );
  assert.equal(stats.interaction, 3);
  assert.equal(stats.reviewed, 2);
  assert.equal(stats.rejections, 3);
  assert.equal(stats.rejectionsPerInteraction, 1.5);
});

test("no reviewed interaction ticket means no average, not a division", () => {
  const stats = collectStats(
    g([t({ id: "h", type: "human_review", status: "review" }), t({ id: "a" })])
  );
  assert.equal(stats.reviewed, 0);
  assert.equal(stats.rejectionsPerInteraction, null);
});

test("runs without a reported cost are tracked separately", () => {
  const stats = collectStats(
    g([
      t({ id: "a", stats: s({ runs: 1, tokens: 900, costUsd: 0.2 }) }),
      // A Codex run: tokens, no cost.
      t({ id: "b", stats: s({ runs: 2, tokens: 100, runsWithoutCost: 2 }) }),
    ])
  );
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
