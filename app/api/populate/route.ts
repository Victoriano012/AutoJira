import { AttachmentPayload, writeAttachments } from "@/lib/attachments";
import { selectedModel } from "@/lib/config";
import { runAgent } from "@/lib/server/agent";
import fs from "fs";
import os from "os";
import path from "path";

export const maxDuration = 300;

// Runs through the selected coding-agent CLI rather than a raw model API, so
// it uses the same Claude Code or Codex login as ticket runs.
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
          // indexes into this array of tickets that must complete first
          dependsOn: { type: "array", items: { type: "integer" } },
        },
        required: ["title", "description", "type", "dependsOn"],
        additionalProperties: false,
      },
    },
  },
  required: ["tickets"],
  additionalProperties: false,
} as const;

export async function POST(req: Request) {
  const { description, chain, attachments } = (await req.json()) as {
    description: string;
    /** Inherited context: project + ancestor tickets, outermost first. */
    chain?: { title: string; description: string }[];
    attachments?: AttachmentPayload[];
  };

  let cwd = os.tmpdir();
  let files: string[] = [];
  if (attachments?.length) {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "autojira-populate-"));
    files = writeAttachments(cwd, attachments);
  }

  const prompt = [
    `Break the following project down into a dependency graph of tickets for an AI coding agent to execute one by one.`,
    files.length
      ? `First read these attached reference files, then answer:\n${files
          .map((f) => `- ${f}`)
          .join("\n")}`
      : `Answer directly from the description — do not use any tools.`,
    chain?.length &&
      `Context — this graph is nested inside (outermost first):\n${chain
        .map((c) => `- ${c.title}${c.description ? `: ${c.description}` : ""}`)
        .join("\n")}`,
    `\nProject / task description:\n${description}`,
    `\nRules:
- 4 to 12 tickets, each a self-contained unit of work an AI coding agent can do in one session.
- Each ticket's description tells the agent exactly what to build/do and how it fits the whole.
- dependsOn lists the indexes (0-based, into your tickets array) of tickets that must be finished first. Only real dependencies — keep the graph as parallel as possible. No cycles.
- Order the array so dependencies come before dependents.
- Use type "human_review" for the few tickets where a human should test the result and give feedback (e.g. after a first runnable version, before deployment). Use type "ai" for everything else. A human_review ticket holds its dependents until the person approves it.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const result = await runAgent({
      prompt,
      workspaceDir: cwd,
      signal: req.signal,
      model: selectedModel(),
      maxTurns: files.length ? 16 : 4,
      outputSchema: GRAPH_SCHEMA,
    });
    if (result.ok && result.structuredOutput) {
      return Response.json(result.structuredOutput);
    }
    return Response.json(
      { error: `Graph generation failed: ${result.text}` },
      { status: 502 }
    );
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
