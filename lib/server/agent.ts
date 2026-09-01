import { query, type ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs";
import os from "os";
import path from "path";
import { resumableSession, tagSession } from "../agent-session";
import { AttachmentPayload, writeAttachments } from "../attachments";
import { selectedModel } from "../config";
import { providerForModel } from "../models";
import { streamCodexAgent } from "./codex";

/** What one agent session cost, as the provider reported it. Nothing is
 * modelled here: a provider that gives no cost figure (the Codex CLI gives
 * tokens only) leaves `costUsd` absent rather than being priced from a table. */
export interface RunUsage {
  tokens: number;
  costUsd?: number;
}

/** One agent turn, as the ticket runner consumes it. */
export type AgentEvent =
  | { type: "init"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; text: string }
  | {
      type: "result";
      ok: boolean;
      text: string;
      structuredOutput?: unknown;
      usage?: RunUsage;
    }
  | { type: "error"; message: string };

export interface AgentRequest {
  workspaceDir?: string;
  prompt: string;
  sessionId?: string;
  attachments?: AttachmentPayload[];
  signal: AbortSignal;
  /** Capture once at the start when prompt construction also depends on it. */
  model?: string;
  /** Ticket work and side chat may edit; planners remain read-only. */
  writeAccess?: boolean;
  maxTurns?: number;
  outputSchema?: Record<string, unknown>;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  structuredOutput?: unknown;
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

function workspaceDir(requested?: string): string {
  return (
    requested?.trim() ||
    process.env.AUTOPROJECT_WORKSPACE ||
    path.join(os.tmpdir(), "autoproject-workspace")
  );
}

function promptWithAttachments(
  cwd: string,
  prompt: string,
  attachments?: AttachmentPayload[]
): string {
  if (!attachments?.length) return prompt;
  const files = writeAttachments(
    path.join(cwd, ".autoproject", "attachments"),
    attachments
  );
  return (
    `Reference files attached to this ticket or inherited from parent tickets (read them when relevant):\n` +
    files.map((file) => `- ${file}`).join("\n") +
    `\n\n${prompt}`
  );
}

/** Run one agent session through the CLI that owns the selected model. */
export async function* streamAgent(req: AgentRequest): AsyncGenerator<AgentEvent> {
  const cwd = workspaceDir(req.workspaceDir);
  fs.mkdirSync(cwd, { recursive: true });
  const model = req.model ?? selectedModel();
  const prompt = promptWithAttachments(cwd, req.prompt, req.attachments);
  const prepared = { ...req, workspaceDir: cwd, prompt, model };

  if (providerForModel(model) === "codex") {
    yield* streamCodexAgent(prepared);
    return;
  }
  yield* streamClaudeAgent(prepared);
}

/** Convenience wrapper for request/response routes. */
export async function runAgent(req: AgentRequest): Promise<AgentResult> {
  let result: AgentResult = {
    ok: false,
    text: "No result from agent",
    sessionId: req.sessionId,
  };
  for await (const event of streamAgent(req)) {
    if (event.type === "init") result.sessionId = event.sessionId;
    else if (event.type === "result") {
      result = {
        ok: event.ok,
        text: event.text,
        sessionId: result.sessionId,
        structuredOutput: event.structuredOutput,
      };
    } else if (event.type === "error") {
      result = { ok: false, text: event.message, sessionId: result.sessionId };
    }
  }
  return result;
}

function claudeUsage(modelUsage: Record<string, ModelUsage>): RunUsage {
  let tokens = 0;
  let costUsd = 0;
  for (const u of Object.values(modelUsage ?? {})) {
    tokens +=
      u.inputTokens +
      u.outputTokens +
      u.cacheReadInputTokens +
      u.cacheCreationInputTokens;
    costUsd += u.costUSD;
  }
  return { tokens, costUsd };
}

async function* streamClaudeAgent(req: AgentRequest): AsyncGenerator<AgentEvent> {
  const model = req.model!;
  const resume = resumableSession(req.sessionId, model);
  const kill = new AbortController();
  const q = query({
    prompt: req.prompt,
    options: {
      cwd: req.workspaceDir,
      model,
      maxTurns: req.maxTurns ?? 150,
      abortController: kill,
      ...(req.writeAccess
        ? {
            permissionMode: "bypassPermissions" as const,
            allowDangerouslySkipPermissions: true,
          }
        : {}),
      ...(resume ? { resume: resume.raw } : {}),
      ...(req.outputSchema
        ? {
            outputFormat: {
              type: "json_schema" as const,
              schema: req.outputSchema,
            },
          }
        : {}),
    },
  });

  // Claude's interrupt is only effective after init, so hold an early stop
  // until the session is live and keep process abort as the backstop.
  let live = false;
  let sent = false;
  const interrupt = () => {
    if (!live || sent) return;
    sent = true;
    q.interrupt().catch(() => {});
  };
  const onAbort = () => {
    interrupt();
    setTimeout(() => kill.abort(), 8000).unref?.();
  };
  if (req.signal.aborted) onAbort();
  req.signal.addEventListener("abort", onAbort);

  try {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        live = true;
        if (req.signal.aborted) interrupt();
        yield {
          type: "init",
          sessionId: tagSession("claude", msg.session_id),
        };
      } else if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            yield { type: "text", text: block.text };
          } else if (block.type === "tool_use") {
            yield { type: "tool", text: describeTool(block.name, block.input) };
          }
        }
      } else if (msg.type === "result") {
        // modelUsage is the SDK's own accounting field (main loop, subagents
        // and internal calls), cumulative over this query() call — one prompt
        // here, so the single result message carries the whole session.
        const usage = claudeUsage(msg.modelUsage);
        yield msg.subtype === "success"
          ? {
              type: "result",
              ok: !msg.is_error,
              text: msg.result,
              structuredOutput: msg.structured_output,
              usage,
            }
          : {
              type: "result",
              ok: false,
              text: `Agent stopped: ${msg.subtype}`,
              usage,
            };
      }
    }
  } catch (err) {
    yield { type: "error", message: String(err) };
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
}
