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
