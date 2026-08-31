import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mergeRunState } from "../lib/run-state.ts";
import type { Project, Ticket, TicketGraph } from "../lib/types.ts";

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
const p = (tickets: Ticket[]): Project => ({
  name: "p",
  description: "",
  workspaceDir: "/tmp/p",
  graph: g(tickets),
});
const count = (graph: TicketGraph): number =>
  graph.tickets.reduce((n, x) => n + 1 + count(x.subgraph), 0);

test("a snapshot keeps a card the server has never seen", () => {
  const mine = t({ id: "mine", title: "Browser only" });
  const merged = mergeRunState(p([t({ id: "a" }), mine]), p([t({ id: "a" })]));
  assert.deepEqual(
    merged.graph.tickets.map((x) => x.id),
    ["a", "mine"]
  );
});

test("a snapshot keeps a board card the server has never seen", () => {
  const board = (kids: Ticket[]) =>
    t({ id: "board", type: "human_review", subgraph: g(kids) });
  const merged = mergeRunState(
    p([board([t({ id: "old" }), t({ id: "new" })])]),
    p([board([t({ id: "old", status: "done" })])])
  );
  const kids = merged.graph.tickets[0].subgraph.tickets;
  assert.deepEqual(
    kids.map((x) => x.id),
    ["old", "new"]
  );
  assert.equal(kids[0].status, "done"); // run field: the server's
});

test("a snapshot does not add cards the browser has deleted", () => {
  const merged = mergeRunState(p([t({ id: "a" })]), p([t({ id: "a" }), t({ id: "gone" })]));
  assert.equal(count(merged.graph), 1);
});

test("a snapshot never changes how many tickets there are", () => {
  const browser = p([
    t({ id: "board", type: "human_review", subgraph: g([t({ id: "c1" }), t({ id: "c2" })]) }),
    t({ id: "loose" }),
  ]);
  const server = p([
    t({ id: "board", type: "human_review", subgraph: g([t({ id: "c1", status: "review" })]) }),
    t({ id: "stale" }),
  ]);
  assert.equal(count(mergeRunState(browser, server).graph), count(browser.graph));
});

test("the browser keeps its own fields, the server keeps the run's", () => {
  const merged = mergeRunState(
    p([t({ id: "a", title: "renamed here", status: "todo", log: [] })]),
    p([
      t({
        id: "a",
        title: "old name",
        status: "running",
        log: [{ ts: 1, kind: "info", text: "from the run" }],
      }),
    ])
  );
  const a = merged.graph.tickets[0];
  assert.equal(a.title, "renamed here");
  assert.equal(a.status, "running");
  assert.equal(a.log.length, 1);
});
