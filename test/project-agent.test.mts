import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { ADD_TICKETS_SHAPE } from "../lib/server/board-tools.ts";
import { panelPreamble, systemAppend } from "../lib/server/project-agent.ts";
import { ticketPrompt } from "../lib/server/runs.ts";
import type { Project, Ticket } from "../lib/types.ts";

/**
 * The words the project agent and the ticket agents are given, as pure
 * functions: what a ticket prompt carries from the project, what a panel turn
 * is told about tickets, and the shape the board tool accepts.
 */

const t = (p: Partial<Ticket> & { id: string }): Ticket => ({
  title: p.id,
  description: "",
  status: "todo",
  log: [],
  ...p,
});
const p = (over: Partial<Project> = {}): Project => ({
  name: "Shop",
  description: "An online shop.",
  workspaceDir: "/tmp/shop",
  notes: [],
  tickets: [],
  chat: [],
  ...over,
});

test("a ticket prompt carries the project's standing instructions", () => {
  const ticket = t({ id: "a", title: "Add a cart", description: "Build the cart page." });
  const withNotes = ticketPrompt(
    p({ notes: ["Always use pnpm.", "Never touch /legacy."], tickets: [ticket] }),
    ticket
  );
  assert.match(withNotes, /Standing instructions for this project \(always apply\):/);
  assert.match(withNotes, /- Always use pnpm\./);
  assert.match(withNotes, /- Never touch \/legacy\./);
  assert.match(withNotes, /Build the cart page\./);
  // No notes, no section: an empty heading would read as an instruction lost.
  const bare = ticketPrompt(p({ tickets: [ticket] }), ticket);
  assert.doesNotMatch(bare, /Standing instructions/);
});

test("a panel turn is told the granularity rules and the board tool", () => {
  const text = panelPreamble(p({ tickets: [t({ id: "open" }), t({ id: "done", status: "done" })] }), "Add a cart");
  assert.match(text, /^MODE: PANEL/);
  assert.match(text, /Prefer fewer, larger tickets/);
  assert.match(text, /tightly coupled .* is ONE ticket/);
  assert.match(text, /`files` lists every workspace-relative path/);
  assert.match(text, /Do not modify files in this mode/);
  assert.match(text, /Human:\nAdd a cart$/);
  // The board state names the unsolved tickets only.
  assert.match(text, /- open \[todo\]/);
  assert.doesNotMatch(text, /- done \[done\]/);
  // The tool names as the model sees them live in the stable role text.
  assert.match(systemAppend(p()), /mcp__board__add_tickets/);
  assert.match(systemAppend(p()), /mcp__board__set_notes/);
});

test("the board tool accepts an empty list and insists on files", () => {
  const schema = z.object(ADD_TICKETS_SHAPE);
  assert.equal(schema.safeParse({ tickets: [] }).success, true);
  assert.equal(
    schema.safeParse({
      tickets: [{ title: "Cart", description: "Build it.", files: ["src/cart.tsx"] }],
    }).success,
    true
  );
  assert.equal(
    schema.safeParse({ tickets: [{ title: "Cart", description: "Build it." }] }).success,
    false
  );
});

test("messages queue behind a running turn, in order, and cancelling drops one", async () => {
  const fs = await import("node:fs");
  const { writeProject } = await import("../lib/projects-fs.ts");
  const store = await import("../lib/server/project-store.ts");
  const { registry, runState } = await import("../lib/server/runs.ts");
  const { cancelRequest, sendToAgent } = await import("../lib/server/project-agent.ts");
  const { defaultProject } = await import("../lib/types.ts");
  const dir =
    "/private/tmp/claude-501/-Users-victor-Documents-personal-AutoProject/4fe223bd-0cee-4edf-931c-01648c66e1ed/scratchpad/agent-queue";
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writeProject(dir, defaultProject("Queue", dir));
  const events: string[] = [];
  const unsubscribe = store.subscribe(dir, (e) => events.push(e.type));
  // A turn in progress: nothing sent now may start, and the agent SDK is never reached.
  registry.agents.set(dir, new AbortController());
  try {
    const a = sendToAgent(dir, "panel", "Add a cart");
    const b = sendToAgent(dir, "panel", "Add checkout");
    assert.deepEqual(
      runState(dir).agent.requests.map((r) => [r.text, r.state]),
      [["Add a cart", "queued"], ["Add checkout", "queued"]]
    );
    // Nothing waiting was said to the agent yet; every change told the feed.
    assert.equal(store.getProject(dir)!.chat.length, 0);
    assert.ok(events.includes("agent"));

    cancelRequest(dir, a.id);
    assert.deepEqual(runState(dir).agent.requests.map((r) => r.id), [b.id]);
    cancelRequest(dir, b.id);
    assert.deepEqual(runState(dir).agent.requests, []);
    assert.equal(registry.agents.has(dir), true); // the live turn is not the queue's to stop
  } finally {
    unsubscribe();
    registry.agents.delete(dir);
    registry.requests.delete(dir);
    store.forget(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
