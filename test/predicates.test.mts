import assert from "node:assert/strict";
import test from "node:test";
import {
  boardColumn,
  fileBlockedBy,
  fileBlockees,
  fileClaims,
  isTicketDone,
  notReadyReason,
  satisfiesDependents,
  satisfiesDependentsOnBoard,
  stuckCards,
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

/**
 * The board's promise: a card in Working has an agent on it or is about to get
 * one. It broke because the person's stop lived only in the server's registry —
 * `boardColumn` cannot see that, so every stopped card sat in Working saying
 * "Queued" with nothing ever starting it. `notReadyReason` is the scheduler's
 * own answer, and `stuckCards` is the board checked against it.
 */

test("a stop the board cannot see is exactly the lie", () => {
  const graph = g([t({ id: "A", type: "human_review" })]);
  const card = graph.tickets[0];
  // The registry stopped it. Nothing on the ticket says so, so the board puts
  // it in Working and labels it Queued — and the scheduler never starts it.
  const stopped = { stopped: () => true };
  assert.equal(boardColumn(graph, card, true), "working");
  assert.equal(notReadyReason(graph, card, true, stopped), "the person stopped it");
  assert.deepEqual(
    stuckCards(graph, stopped).map((s) => s.ticket.id),
    ["A"]
  );
  // Persisting the same stop as `paused` is the fix: the board reads it, puts
  // the card in Blocked with a Run button, and the promise holds again.
  const parked = g([t({ id: "A", type: "human_review", paused: true })]);
  assert.equal(boardColumn(parked, parked.tickets[0], true), "blocked");
  assert.deepEqual(stuckCards(parked, stopped), []);
});

test("a card the board already shows as Blocked is not a lie", () => {
  // Both reasons the board renders: an unmet dependency and a held file. The
  // scheduler refuses these too, and says why, but the card is in Blocked.
  const deps = g(
    [t({ id: "up", type: "human_review" }), t({ id: "down", type: "human_review" })],
    [["up", "down"]]
  );
  assert.equal(notReadyReason(deps, deps.tickets[1], true), 'waiting on “up”');
  assert.deepEqual(stuckCards(deps), []);

  const files = g([
    t({ id: "A", type: "human_review", status: "running", files: ["a.ts"] }),
    t({ id: "B", type: "human_review", files: ["a.ts"] }),
  ]);
  assert.equal(
    notReadyReason(files, files.tickets[1], true),
    'waiting for a.ts, held by “A”'
  );
  assert.deepEqual(stuckCards(files), []);
});

test("a card that says what it is cannot be lying", () => {
  // Working holds three kinds of card. Only "Queued" promises an agent is
  // coming; a spinner and a Failed-with-Retry both say where they really are.
  for (const status of ["running", "error"] as const) {
    const graph = g([t({ id: "A", type: "human_review", status })]);
    assert.equal(boardColumn(graph, graph.tickets[0], true), "working");
    assert.deepEqual(stuckCards(graph, { stopped: () => true }), []);
  }
  // And a healthy queued card is the promise being kept, not broken.
  const ready = g([t({ id: "A", type: "human_review" })]);
  assert.equal(notReadyReason(ready, ready.tickets[0], true), null);
  assert.deepEqual(stuckCards(ready), []);
});

test("the scheduler's refusals and the board's Working column line up", () => {
  // The whole invariant in one shape: whatever the scheduler will not start is
  // a card the board does not show as Queued.
  const graph = g(
    [
      t({ id: "done", type: "human_review", status: "done" }),
      t({ id: "gate", type: "human_review", status: "review" }),
      t({ id: "runs", type: "human_review", status: "running", files: ["a.ts"] }),
      t({ id: "waits", type: "human_review", files: ["a.ts"] }),
      t({ id: "held", type: "human_review" }),
      t({ id: "off", type: "human_review", paused: true }),
      t({ id: "go", type: "human_review" }),
    ],
    [["gate", "held"]]
  );
  const ready = graph.tickets.filter((x) => notReadyReason(graph, x, true) === null);
  // A board card in review does not gate the rest of the board, so "held" runs.
  assert.deepEqual(ready.map((x) => x.id), ["held", "go"]);
  assert.deepEqual(stuckCards(graph), []);
});

test("a card waiting on a dependency is not also waiting on a file", () => {
  // "gate" is unfinished, so "waits" cannot start whatever the files say — and
  // the file may well be free by its turn. One reason, on both cards: the
  // holder must not claim a waiter that is not actually waiting on it.
  const graph = g(
    [
      t({ id: "gate", type: "human_review" }),
      t({ id: "holds", type: "human_review", status: "running", files: ["a.ts"] }),
      t({ id: "waits", type: "human_review", files: ["a.ts"] }),
    ],
    [["gate", "waits"]]
  );
  const waits = graph.tickets[2];
  assert.deepEqual(fileClaims(graph, "waits", true), []);
  assert.deepEqual(fileBlockees(graph, "holds", true), []);
  // The physical answer is still yes, and has to be: anything that would start
  // the agent now must not forget that another agent is in that file.
  assert.equal(fileBlockedBy(graph, "waits", true)?.by.id, "holds");
  // Blocked either way, and for the dependency, which is the truth.
  assert.equal(boardColumn(graph, waits, true), "blocked");
  assert.match(notReadyReason(graph, waits, true)!, /waiting on “gate”/);
});

test("the file reason comes back the moment the dependency is met", () => {
  const graph = g(
    [
      t({ id: "gate", type: "human_review", status: "done" }),
      t({ id: "holds", type: "human_review", status: "running", files: ["a.ts"] }),
      t({ id: "waits", type: "human_review", files: ["a.ts"] }),
    ],
    [["gate", "waits"]]
  );
  assert.equal(fileBlockedBy(graph, "waits", true)?.by.id, "holds");
  assert.deepEqual(
    fileBlockees(graph, "holds", true).map((b) => b.who.id),
    ["waits"]
  );
  assert.match(notReadyReason(graph, graph.tickets[2], true)!, /waiting for a\.ts/);
});

test("a holder keeps the waiters who really are waiting on its file", () => {
  // Two waiters, one of them stuck behind a dependency: the holder lists the
  // other one only, and the line does not disappear with it.
  const graph = g(
    [
      t({ id: "gate", type: "human_review" }),
      t({ id: "holds", type: "human_review", status: "running", files: ["a.ts"] }),
      t({ id: "blocked", type: "human_review", files: ["a.ts"] }),
      t({ id: "free", type: "human_review", files: ["a.ts"] }),
    ],
    [["gate", "blocked"]]
  );
  assert.deepEqual(
    fileBlockees(graph, "holds", true).map((b) => b.who.id),
    ["free"]
  );
});

test("dependencies still win when the file holder is the dependency", () => {
  // The same ticket on both sides: nothing may recurse forever, and the card
  // is told about the dependency, not the file.
  const graph = g(
    [
      t({ id: "first", type: "human_review", status: "running", files: ["a.ts"] }),
      t({ id: "second", type: "human_review", files: ["a.ts"] }),
    ],
    [["first", "second"]]
  );
  assert.deepEqual(fileClaims(graph, "second", true), []);
  assert.deepEqual(fileBlockees(graph, "first", true), []);
  assert.match(notReadyReason(graph, graph.tickets[1], true)!, /waiting on “first”/);
});
