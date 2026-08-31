import assert from "node:assert/strict";
import test from "node:test";
import {
  boardColumn,
  fileBlockedBy,
  fileBlockees,
  isTicketDone,
  satisfiesDependents,
  satisfiesDependentsOnBoard,
} from "../lib/types.ts";
import type { Ticket, TicketGraph } from "../lib/types.ts";

/**
 * The scheduling predicates, in the shapes that have actually gone wrong: who
 * lets their dependents start, and who is holding a file. Both rules are read
 * by the board, by the graph view and by the server's scheduler, so a change
 * that looks local to one of them is not.
 *
 * Run with `npm test` (node's own runner strips the types, no dependencies).
 */

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
const g = (tickets: Ticket[], deps: [string, string][] = []): TicketGraph => ({
  tickets,
  edges: deps.map(([source, target]) => ({ id: source + target, source, target })),
});

test("an agent ticket in review lets its dependents start", () => {
  // The agent has stopped and its changes are on disk: nothing is left to wait
  // for. This is the rule that regressed when `blocking` was removed.
  assert.equal(satisfiesDependents(t({ id: "a", status: "review" })), true);
  assert.equal(satisfiesDependents(t({ id: "a", status: "done" })), true);
  assert.equal(satisfiesDependents(t({ id: "a", status: "todo" })), false);
  assert.equal(satisfiesDependents(t({ id: "a", status: "running" })), false);
  assert.equal(satisfiesDependents(t({ id: "a", status: "error" })), false);
});

test("a human ticket in the graph holds its dependents until it is done", () => {
  // A gate exists to be signed off; reaching review is it asking, not it
  // finishing. Victor asked for this one explicitly — do not weaken it.
  const gate = t({ id: "h", type: "human_review", status: "review" });
  assert.equal(satisfiesDependents(gate), false);
  assert.equal(satisfiesDependents({ ...gate, status: "done" }), true);
});

test("a card on a board never holds the board, review or not", () => {
  // Every card is a human review, so the graph rule would block the whole
  // board behind whichever card is waiting for its ✓.
  const card = t({ id: "c", type: "human_review", status: "review" });
  assert.equal(satisfiesDependentsOnBoard(card), true);
  assert.equal(satisfiesDependentsOnBoard({ ...card, status: "todo" }), false);
  assert.equal(satisfiesDependentsOnBoard({ ...card, status: "done" }), true);
});

test("both predicates take one argument, so a bare callback is safe", () => {
  // `.every(satisfiesDependents)` hands the callback the element index; a
  // second parameter would read it as "this is a board" from the second
  // element on, and every gate after the first would leak.
  const gate = t({ id: "h", type: "human_review", status: "review" });
  const done = t({ id: "d", status: "done" });
  assert.equal([done, gate].every(satisfiesDependents), false);
  assert.equal([done, gate].filter(satisfiesDependents).length, 1);
  assert.equal(satisfiesDependents.length, 1);
  assert.equal(satisfiesDependentsOnBoard.length, 1);
});

test("a human ticket is only ever finished by its person", () => {
  const board = t({
    id: "H",
    type: "human_review",
    status: "todo",
    subgraph: g([t({ id: "c1", status: "done" }), t({ id: "c2", status: "done" })]),
  });
  assert.equal(isTicketDone(board), false);
  assert.equal(isTicketDone({ ...board, status: "done" }), true);
});

test("a card in review does not block the cards after it", () => {
  // Victor's board: three todo cards behind one card waiting for its ✓.
  const graph = g(
    [
      t({ id: "up", type: "human_review", status: "review" }),
      t({ id: "down", type: "human_review", status: "todo" }),
    ],
    [["up", "down"]]
  );
  const down = graph.tickets[1];
  assert.equal(boardColumn(graph, down, true), "working");
  // The same shape in the graph view still waits on its gate.
  assert.equal(boardColumn(graph, down), "blocked");
});

test("only a card in Working holds its files", () => {
  const holder = (over: Partial<Ticket>) =>
    t({ id: "A", files: ["src/hero.tsx"], ...over });
  const waiter = t({ id: "B", files: ["./src/hero.tsx"] });
  const held = (h: Ticket) => fileBlockedBy(g([h, waiter]), "B", true)?.by.id ?? null;

  assert.equal(held(holder({ status: "running" })), "A");
  assert.equal(held(holder({ status: "todo" })), "A"); // about to be dispatched
  assert.equal(held(holder({ status: "error" })), "A"); // half-finished edits
  // Everything below is a card the person can see is not being worked on.
  assert.equal(held(holder({ status: "review" })), null);
  assert.equal(held(holder({ status: "done" })), null);
  assert.equal(held(holder({ status: "todo", paused: true })), null);
});

test("a card blocked by a dependency holds nothing either", () => {
  // A holds hero.tsx but cannot start until the gate is signed off, so C is
  // not waiting for A — it blocks only through its own edges.
  const graph = g(
    [
      t({ id: "gate", type: "human_review", status: "todo" }),
      t({ id: "A", files: ["src/hero.tsx"] }),
      t({ id: "C", files: ["src/hero.tsx"] }),
    ],
    [["gate", "A"]]
  );
  assert.equal(boardColumn(graph, graph.tickets[1], true), "blocked");
  assert.equal(fileBlockedBy(graph, "C", true), null);
});

test("a claim names one file per pair, and the holder sees who waits", () => {
  const graph = g([
    t({ id: "A", status: "running", files: ["b.ts", "a.ts"] }),
    t({ id: "B", files: ["a.ts", "b.ts", "c.ts"] }),
  ]);
  const claim = fileBlockedBy(graph, "B", true)!;
  assert.equal(claim.file, "a.ts"); // sorted, so both cards name the same one
  const [waiting] = fileBlockees(graph, "A", true);
  assert.equal(waiting.who.id, "B");
  assert.equal(waiting.file, "a.ts");
  assert.deepEqual(waiting.files, ["a.ts", "b.ts"]);
  // Nobody waits on a file nobody else declared.
  assert.equal(fileBlockees(graph, "B", true).length, 0);
});
