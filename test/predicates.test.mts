import assert from "node:assert/strict";
import test from "node:test";
import {
  boardColumn,
  byArrival,
  fileBlockedBy,
  fileBlockees,
  fileClaims,
  hasRunnableWork,
  isTicketDone,
  notReadyReason,
  stuckCards,
  workerBusyOn,
} from "../lib/types.ts";
import type { Ticket } from "../lib/types.ts";

/**
 * The scheduling predicates, in the shapes that have actually gone wrong: who
 * is holding a file, and which card the board may call Queued. Both rules are
 * read by the board and by the server's scheduler, so a change that looks
 * local to one of them is not.
 *
 * Run with `npm test` (node's own runner strips the types, no dependencies).
 */

const t = (p: Partial<Ticket> & { id: string }): Ticket => ({
  title: p.id,
  description: "",
  status: "todo",
  log: [],
  ...p,
});

test("a ticket is only ever finished by its person", () => {
  // The agent reaching review is it asking, not it finishing.
  assert.equal(isTicketDone(t({ id: "a", status: "review" })), false);
  assert.equal(isTicketDone(t({ id: "a", status: "done" })), true);
});

test("the column is a function of the status alone", () => {
  assert.equal(boardColumn(t({ id: "a", status: "todo" })), "blocked");
  assert.equal(boardColumn(t({ id: "a", status: "error" })), "blocked");
  assert.equal(boardColumn(t({ id: "a", status: "running" })), "working");
  assert.equal(boardColumn(t({ id: "a", status: "review" })), "review");
  assert.equal(boardColumn(t({ id: "a", status: "done" })), "done");
});

test("a column orders by arrival, newcomers last", () => {
  const tickets = [
    t({ id: "late", statusChangedAt: 300 }),
    t({ id: "early", statusChangedAt: 100 }),
    t({ id: "unstamped" }), // an older project: sorts first, never throws
    t({ id: "mid", statusChangedAt: 200 }),
  ];
  assert.deepEqual(
    [...tickets].sort(byArrival).map((x) => x.id),
    ["unstamped", "early", "mid", "late"]
  );
});

test("only a card in Working holds its files", () => {
  const holder = (over: Partial<Ticket>) =>
    t({ id: "A", files: ["src/hero.tsx"], ...over });
  const waiter = t({ id: "B", files: ["./src/hero.tsx"] });
  const held = (h: Ticket) => fileBlockedBy([h, waiter], "B")?.by.id ?? null;

  assert.equal(held(holder({ status: "running" })), "A");
  // Everything below is a card the person can see is not being worked on.
  assert.equal(held(holder({ status: "todo" })), null);
  assert.equal(held(holder({ status: "error" })), null);
  assert.equal(held(holder({ status: "review" })), null);
  assert.equal(held(holder({ status: "done" })), null);
});

test("a finished ticket wants nothing, a ticket in review still does", () => {
  const tickets = [
    t({ id: "A", status: "running", files: ["a.ts"] }),
    t({ id: "done", status: "done", files: ["a.ts"] }),
    t({ id: "back", status: "review", files: ["a.ts"] }),
  ];
  assert.equal(fileBlockedBy(tickets, "done"), null);
  // `sendFeedback` asks this before putting the agent back to work.
  assert.equal(fileBlockedBy(tickets, "back")?.by.id, "A");
});

test("a claim names one file per pair, and the holder sees who waits", () => {
  const tickets = [
    t({ id: "A", status: "running", files: ["b.ts", "a.ts"] }),
    t({ id: "B", files: ["a.ts", "b.ts", "c.ts"] }),
  ];
  const claim = fileBlockedBy(tickets, "B")!;
  assert.equal(claim.file, "a.ts"); // sorted, so both cards name the same one
  const [waiting] = fileBlockees(tickets, "A");
  assert.equal(waiting.who.id, "B");
  assert.equal(waiting.file, "a.ts");
  assert.deepEqual(waiting.files, ["a.ts", "b.ts"]);
  // Nobody waits on a file nobody else declared.
  assert.equal(fileBlockees(tickets, "B").length, 0);
});

test("a holder lists only the cards that are actually stuck on it", () => {
  const tickets = [
    t({ id: "holds", status: "running", files: ["a.ts"] }),
    t({ id: "waits", files: ["a.ts"] }),
    // In review: it would wait if sent back, but nobody is held up now.
    t({ id: "asks", status: "review", files: ["a.ts"] }),
  ];
  assert.deepEqual(
    fileBlockees(tickets, "holds").map((b) => b.who.id),
    ["waits"]
  );
  assert.deepEqual(fileClaims(tickets, "waits").map((c) => c.by.id), ["holds"]);
});

/**
 * The board's promise: a card in Working has an agent on it or is about to get
 * one. It broke because the person's stop lived only in the server's registry —
 * `boardColumn` cannot see that, so every stopped card sat in Working saying
 * "Queued" with nothing ever starting it. `notReadyReason` is the scheduler's
 * own answer, and `stuckCards` is the board checked against it.
 */

test("a stop the board cannot see is not a Working card any more", () => {
  const card = t({ id: "A" });
  const stopped = { stopped: () => true };
  // A todo card sits in Blocked, so the scheduler's refusal matches the board.
  assert.equal(boardColumn(card), "blocked");
  assert.equal(notReadyReason([card], card, stopped), "the person stopped it");
  assert.deepEqual(stuckCards([card], stopped), []);
  // Persisting the same stop as `paused` reads the same way, with a Run button.
  const parked = t({ id: "A", paused: true });
  assert.equal(notReadyReason([parked], parked), "the person paused it");
  assert.deepEqual(stuckCards([parked], stopped), []);
});

test("a card the board already shows as Blocked is not a lie", () => {
  const files = [
    t({ id: "A", status: "running", files: ["a.ts"] }),
    t({ id: "B", files: ["a.ts"] }),
  ];
  assert.equal(notReadyReason(files, files[1]), 'waiting for a.ts, held by “A”');
  assert.deepEqual(stuckCards(files), []);
});

test("a card that says what it is cannot be lying", () => {
  // Working holds the running card only; a spinner says where it really is.
  const running = t({ id: "A", status: "running" });
  assert.equal(boardColumn(running), "working");
  assert.deepEqual(stuckCards([running], { stopped: () => true }), []);
  assert.equal(notReadyReason([running], running), "its status is running");
  // A healthy queued card is the promise being kept.
  const ready = t({ id: "A" });
  assert.equal(notReadyReason([ready], ready), null);
  assert.deepEqual(stuckCards([ready]), []);
});

test("the scheduler's refusals and the runnable-work check line up", () => {
  const tickets = [
    t({ id: "done", status: "done" }),
    t({ id: "asks", status: "review" }),
    t({ id: "runs", status: "running", files: ["a.ts"] }),
    t({ id: "waits", files: ["a.ts"] }),
    t({ id: "off", paused: true }),
    t({ id: "go" }),
  ];
  const ready = tickets.filter((x) => notReadyReason(tickets, x) === null);
  assert.deepEqual(ready.map((x) => x.id), ["go"]);
  assert.equal(hasRunnableWork(tickets), true);
  assert.equal(hasRunnableWork(tickets.filter((x) => x.id !== "go")), false);
  assert.deepEqual(stuckCards(tickets), []);
});

test("two tickets of one worker never run at once", () => {
  const tickets = [
    t({ id: "A", status: "running", workerId: "w1" }),
    t({ id: "B", workerId: "w1" }),
    t({ id: "C", workerId: "w2" }),
    t({ id: "old" }), // from before workers: shares nobody's conversation
  ];
  assert.equal(workerBusyOn(tickets, "B")?.id, "A");
  assert.equal(notReadyReason(tickets, tickets[1]), "waiting for its worker, still on “A”");
  assert.equal(notReadyReason(tickets, tickets[2]), null);
  assert.equal(notReadyReason(tickets, tickets[3]), null);
  assert.deepEqual(stuckCards(tickets), []);
  // Only a card in Working holds its worker: one in review has let go.
  const asked = [t({ id: "A", status: "review", workerId: "w1" }), t({ id: "B", workerId: "w1" })];
  assert.equal(workerBusyOn(asked, "B"), null);
  assert.equal(hasRunnableWork(asked), true);
  assert.equal(hasRunnableWork(tickets.slice(0, 2)), false);
});
