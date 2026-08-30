import { AttachmentPayload, writeAttachments } from "@/lib/attachments";
import { requireUserId } from "@/lib/auth-server";
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs";
import os from "os";
import path from "path";

export const maxDuration = 300;

type AgentEvent =
  | { type: "init"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; text: string }
  | { type: "result"; ok: boolean; text: string; costUsd?: number }
  | { type: "error"; message: string };

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

export async function POST(req: Request) {
  if ((await requireUserId()) == null) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { prompt, sessionId, workspaceDir, attachments } =
    (await req.json()) as {
      prompt: string;
      sessionId?: string;
      workspaceDir?: string;
      attachments?: AttachmentPayload[];
    };

  const cwd =
    workspaceDir?.trim() ||
    process.env.AUTOJIRA_WORKSPACE ||
    path.join(os.tmpdir(), "autojira-workspace");
  fs.mkdirSync(cwd, { recursive: true });

  let fullPrompt = prompt;
  if (attachments?.length) {
    const files = writeAttachments(
      path.join(cwd, ".autojira", "attachments"),
      attachments
    );
    fullPrompt =
      `Reference files attached to this ticket or inherited from parent tickets (read them when relevant):\n` +
      files.map((f) => `- ${f}`).join("\n") +
      `\n\n${prompt}`;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: AgentEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      const q = query({
        prompt: fullPrompt,
        options: {
          cwd,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: 150,
          ...(sessionId ? { resume: sessionId } : {}),
        },
      });
      req.signal.addEventListener("abort", () => {
        q.interrupt().catch(() => {});
      });
      try {
        for await (const msg of q) {
          if (msg.type === "system" && msg.subtype === "init") {
            send({ type: "init", sessionId: msg.session_id });
          } else if (msg.type === "assistant") {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text.trim()) {
                send({ type: "text", text: block.text });
              } else if (block.type === "tool_use") {
                send({ type: "tool", text: describeTool(block.name, block.input) });
              }
            }
          } else if (msg.type === "result") {
            if (msg.subtype === "success") {
              send({
                type: "result",
                ok: !msg.is_error,
                text: msg.result,
                costUsd: msg.total_cost_usd,
              });
            } else {
              send({
                type: "result",
                ok: false,
                text: `Agent stopped: ${msg.subtype}`,
                costUsd: msg.total_cost_usd,
              });
            }
          }
        }
      } catch (err) {
        try {
          send({ type: "error", message: String(err) });
        } catch {
          // client already gone
        }
      }
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
