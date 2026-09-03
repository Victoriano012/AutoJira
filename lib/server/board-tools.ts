import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Ticket } from "../types";
import * as store from "./project-store";
import { autoRun } from "./runs";

/**
 * The board as the project agent sees it in panel mode: two in-process MCP
 * tools. Tickets written this way land on the board mid-turn (the handler
 * writes straight into the store), which is why panel mode does not use the
 * SDK's structured output — that would only arrive when the turn ends.
 */

export const ADD_TICKETS_SHAPE = {
  tickets: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      files: z.array(z.string()),
      // the worker to run it: an existing one by number, or a new one described
      worker: z.union([z.object({ existing: z.number().int() }), z.object({ new: z.string() })]),
    })
  ),
};

/** The same shape as JSON Schema, for the CLIs without in-process MCP
 * (Codex, Gemini): their panel turn answers with this structured output. */
export const REQUEST_SCHEMA = {
  type: "object",
  properties: {
    tickets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          // workspace-relative paths this ticket will create or modify; the
          // board serialises tickets that share one
          files: { type: "array", items: { type: "string" } },
          worker: {
            anyOf: [
              {
                type: "object",
                properties: { existing: { type: "integer" } },
                required: ["existing"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { new: { type: "string" } },
                required: ["new"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["title", "description", "files", "worker"],
        additionalProperties: false,
      },
    },
  },
  required: ["tickets"],
  additionalProperties: false,
} as const;

/** Put the planner's tickets on the board, start them, and say so in the chat. */
export function addTicketsToBoard(dir: string, tickets: store.PlannedTicket[]): Ticket[] {
  const added = store.addTickets(dir, tickets);
  if (added.length === 0) return added;
  autoRun(dir);
  store.appendChat(dir, [
    {
      kind: "info",
      text: `Added ${added.length} ticket(s): ${added.map((t) => t.title).join("; ")}`,
      ts: Date.now(),
      mode: "panel",
      ticketIds: added.map((t) => t.id),
    },
  ]);
  return added;
}

/** Tool names as the model sees them: mcp__board__add_tickets, mcp__board__set_notes. */
export function boardServer(dir: string) {
  return createSdkMcpServer({
    name: "board",
    version: "1",
    tools: [
      tool(
        "add_tickets",
        "Put tickets on the board for the coding agents. Call at most once per request; pass an empty array when the request needs no work.",
        ADD_TICKETS_SHAPE,
        async ({ tickets }) => {
          const added = addTicketsToBoard(dir, tickets);
          return {
            content: [
              {
                type: "text",
                text: `Added ${added.length} ticket(s): ${added.map((t) => t.title).join("; ")}`,
              },
            ],
          };
        }
      ),
      tool(
        "set_notes",
        "Replace the project's standing instructions (short imperative sentences).",
        { notes: z.array(z.string()) },
        async ({ notes }) => {
          store.setNotes(dir, notes);
          return { content: [{ type: "text", text: "Notes saved." }] };
        }
      ),
    ],
  });
}
