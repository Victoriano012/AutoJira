import { query } from "@anthropic-ai/claude-agent-sdk";
import os from "os";

export const maxDuration = 300;

// Breaks a human's board request into tickets, like /api/populate, but keeps
// all requests for one board in a single conversation: the caller passes back
// the sessionId returned by the previous request and we resume it.
const REQUEST_SCHEMA = {
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
          // board serialises tickets that share one, with no dependency
          files: { type: "array", items: { type: "string" } },
          // indexes into this array of tickets that must complete first
          dependsOn: { type: "array", items: { type: "integer" } },
          // numbers of the existing unsolved tickets (as listed in the prompt)
          dependsOnExisting: { type: "array", items: { type: "integer" } },
        },
        required: ["title", "description", "files", "dependsOn", "dependsOnExisting"],
        additionalProperties: false,
      },
    },
  },
  required: ["tickets"],
  additionalProperties: false,
} as const;

export async function POST(req: Request) {
  const { request, sessionId, existing, chain } = (await req.json()) as {
    request: string;
    /** Session of this board's request conversation; omitted on the first request. */
    sessionId?: string;
    /** Unsolved tickets already on the board, referencable as dependencies. */
    existing?: { title: string; description: string; status: string }[];
    /** Inherited context: project + ancestor tickets, outermost first. */
    chain?: { title: string; description: string }[];
  };

  const prompt = [
    sessionId
      ? `Another request from the human on the same kanban board.`
      : [
          `You are the planner behind a kanban board where AI coding agents execute tickets. The human posts change requests; you break each request into tickets for the agents.`,
          chain?.length
            ? `\nBoard context (outermost first):\n${chain
                .map((c) => `- ${c.title}${c.description ? `: ${c.description}` : ""}`)
                .join("\n")}`
            : "",
        ].join("\n"),
    existing?.length
      ? `\nUnsolved tickets currently on the board:\n${existing
          .map(
            (t, i) =>
              `${i}. ${t.title} [${t.status}]${t.description ? ` — ${t.description}` : ""}`
          )
          .join("\n")}`
      : `\nThe board currently has no unsolved tickets.`,
    `\nHuman request:\n${request}`,
    `\nRules:
- Break the request into 1 to 6 tickets, each a self-contained unit of work an AI coding agent can do in one session.
- Each ticket's description tells the agent exactly what to build/do.
- files lists the workspace-relative paths each ticket will create or modify. Be specific and complete: the board uses it to keep two agents out of the same file, running such tickets one after another on its own. Never add a dependency just because two tickets touch the same file — list the file in both and the board handles it.
- dependsOn is only for real ordering: ticket B needs what ticket A actually produces (a component A creates, a decision A makes, data A moves). It lists 0-based indexes into YOUR new tickets array that must finish first; order the array so dependencies come before dependents. dependsOnExisting lists numbers of the existing unsolved tickets above that must finish first. Keep the graph as parallel as possible. No cycles.
- Answer directly from the request — do not use any tools.`,
  ]
    .filter(Boolean)
    .join("\n");

  // One pass at the planner. Throws if the agent process dies under it.
  const ask = async () => {
    let newSessionId: string | undefined;
    for await (const msg of query({
      prompt,
      options: {
        cwd: os.tmpdir(),
        maxTurns: 4,
        outputFormat: { type: "json_schema", schema: REQUEST_SCHEMA },
        ...(sessionId ? { resume: sessionId } : {}),
      },
    })) {
      if (msg.type === "system" && msg.subtype === "init") {
        newSessionId = msg.session_id;
      } else if (msg.type === "result") {
        if (msg.subtype === "success" && msg.structured_output) {
          return Response.json({ ...msg.structured_output, sessionId: newSessionId });
        }
        return Response.json(
          { error: `Ticket generation failed: ${msg.subtype}` },
          { status: 502 }
        );
      }
    }
    return Response.json({ error: "No result from agent" }, { status: 502 });
  };

  try {
    return await ask();
  } catch (err) {
    // The planner process can be killed out from under us (SIGTERM/SIGKILL from
    // the OS, a hot reload, the machine reclaiming memory). Nothing was written
    // and the prompt is unchanged, so just ask once more before giving up.
    if (wasInterrupted(err)) {
      try {
        return await ask();
      } catch (err2) {
        return Response.json({ error: humanError(err2) }, { status: 500 });
      }
    }
    return Response.json({ error: humanError(err) }, { status: 500 });
  }
}

/** The planner was killed rather than failing on its own: signal exit codes
 * (143 SIGTERM, 137 SIGKILL, 130 SIGINT) and abort/close errors all mean the
 * work never happened, so it is safe to repeat. */
function wasInterrupted(err: unknown): boolean {
  return /exited with code (143|137|130)\b|SIGTERM|SIGKILL|abort|closed|ECONNRESET/i.test(
    String(err)
  );
}

/** What the person reads. "process exited with code 143" tells them nothing. */
function humanError(err: unknown): string {
  if (wasInterrupted(err))
    return "The request was interrupted before it finished — send it again.";
  return String(err).replace(/^Error:\s*/, "");
}
