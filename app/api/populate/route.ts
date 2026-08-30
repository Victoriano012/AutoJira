import { query } from "@anthropic-ai/claude-agent-sdk";
import os from "os";

export const maxDuration = 300;

// Runs through the Agent SDK (Claude Code harness) rather than the raw API so
// it uses the same auth as /api/agent — including subscription (OAuth) auth.
const GRAPH_SCHEMA = {
  type: "object",
  properties: {
    tickets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          type: { type: "string", enum: ["ai", "human_review"] },
          // human_review only: false = dependents may start before approval
          blocking: { type: "boolean" },
          // indexes into this array of tickets that must complete first
          dependsOn: { type: "array", items: { type: "integer" } },
        },
        required: ["title", "description", "type", "blocking", "dependsOn"],
        additionalProperties: false,
      },
    },
  },
  required: ["tickets"],
  additionalProperties: false,
} as const;

export async function POST(req: Request) {
  const { description, context } = (await req.json()) as {
    description: string;
    context?: string;
  };

  const prompt = [
    `Break the following project down into a dependency graph of tickets for an AI coding agent to execute one by one. Answer directly from the description — do not use any tools.`,
    context && `Context — this graph is a subgraph of the ticket: ${context}`,
    `\nProject / task description:\n${description}`,
    `\nRules:
- 4 to 12 tickets, each a self-contained unit of work an AI coding agent can do in one session.
- Each ticket's description tells the agent exactly what to build/do and how it fits the whole.
- dependsOn lists the indexes (0-based, into your tickets array) of tickets that must be finished first. Only real dependencies — keep the graph as parallel as possible. No cycles.
- Order the array so dependencies come before dependents.
- Use type "human_review" for the few tickets where a human should test the result and give feedback (e.g. after a first runnable version, before deployment). Use type "ai" for everything else.
- blocking: for human_review tickets, true if dependent work must wait for the human's approval, false if dependents can safely continue in parallel (on a git branch) while the human reviews. For "ai" tickets always set true.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: os.tmpdir(),
        maxTurns: 4,
        outputFormat: { type: "json_schema", schema: GRAPH_SCHEMA },
      },
    })) {
      if (msg.type === "result") {
        if (msg.subtype === "success" && msg.structured_output) {
          return Response.json(msg.structured_output);
        }
        return Response.json(
          { error: `Graph generation failed: ${msg.subtype}` },
          { status: 502 }
        );
      }
    }
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
  return Response.json({ error: "No result from agent" }, { status: 502 });
}
