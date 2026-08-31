import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs";
import os from "os";
import path from "path";
import { AttachmentPayload, writeAttachments } from "../attachments";
import { modelOption } from "../config";

/** One agent turn, as the runner consumes it. Same shape the browser used to
 * receive as NDJSON from /api/agent — the run just no longer crosses the wire. */
export type AgentEvent =
  | { type: "init"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; text: string }
  | { type: "result"; ok: boolean; text: string }
  | { type: "error"; message: string };

export interface AgentRequest {
  workspaceDir?: string;
  prompt: string;
  sessionId?: string;
  attachments?: AttachmentPayload[];
  signal: AbortSignal;
}

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const detail =
    (i.file_path as string) ??
    (i.command as string) ??
    (i.pattern as string) ??
    (i.url as string) ??
    "";
  return detail ? `${name}: ${String(detail).slice(0, 200)}` : name;
}

/** Run one agent session, yielding its events until it finishes or is aborted. */
export async function* streamAgent(req: AgentRequest): AsyncGenerator<AgentEvent> {
  const cwd =
    req.workspaceDir?.trim() ||
    process.env.AUTOJIRA_WORKSPACE ||
    path.join(os.tmpdir(), "autojira-workspace");
  fs.mkdirSync(cwd, { recursive: true });

  let fullPrompt = req.prompt;
  if (req.attachments?.length) {
    const files = writeAttachments(
      path.join(cwd, ".autojira", "attachments"),
      req.attachments
    );
    fullPrompt =
      `Reference files attached to this ticket or inherited from parent tickets (read them when relevant):\n` +
      files.map((f) => `- ${f}`).join("\n") +
      `\n\n${req.prompt}`;
  }

  // Aborting this kills the agent process (after the SDK's own short grace
  // period); it is the backstop for a stop the session will not answer.
  const kill = new AbortController();
  const q = query({
    prompt: fullPrompt,
    options: {
      cwd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 150,
      abortController: kill,
      ...modelOption(),
      ...(req.sessionId ? { resume: req.sessionId } : {}),
    },
  });

  // Stopping is a control message to the running session, so it can only be
  // delivered once the session is up: sent before that it resolves happily and
  // does nothing, and the agent runs on for as long as its work takes (the
  // "I pressed stop and it kept going" bug). So the stop is held until init.
  let live = false;
  let sent = false;
  const interrupt = () => {
    if (!live || sent) return;
    sent = true;
    q.interrupt().catch(() => {});
  };
  const onAbort = () => {
    interrupt();
    // If the session will not stop on its own — a tool call that never returns,
    // a session that never came up — end the process rather than leaving the
    // person watching a ticket they already stopped.
    setTimeout(() => kill.abort(), 8000).unref?.();
  };
  if (req.signal.aborted) onAbort();
  req.signal.addEventListener("abort", onAbort);

  try {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        live = true;
        if (req.signal.aborted) interrupt();
        yield { type: "init", sessionId: msg.session_id };
      } else if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            yield { type: "text", text: block.text };
          } else if (block.type === "tool_use") {
            yield { type: "tool", text: describeTool(block.name, block.input) };
          }
        }
      } else if (msg.type === "result") {
        yield msg.subtype === "success"
          ? { type: "result", ok: !msg.is_error, text: msg.result }
          : { type: "result", ok: false, text: `Agent stopped: ${msg.subtype}` };
      }
    }
  } catch (err) {
    yield { type: "error", message: String(err) };
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
}
