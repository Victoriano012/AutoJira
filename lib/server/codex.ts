import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { resumableSession, tagSession } from "../agent-session";
import type { AgentEvent, AgentRequest } from "./agent";

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  query?: string;
  name?: string;
  server?: string;
  changes?: { path?: string }[];
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string } | string;
  item?: CodexItem;
}

/** Kept separate and exported so the CLI contract can be tested without
 * starting a model run. */
export function codexArgs(
  req: Pick<
    AgentRequest,
    "model" | "sessionId" | "workspaceDir" | "writeAccess"
  >,
  schemaPath?: string
): string[] {
  const model = req.model!;
  const resume = resumableSession(req.sessionId, model);
  const args = ["exec"];
  if (resume) args.push("resume", resume.raw);
  args.push("--json", "--model", model, "--skip-git-repo-check");
  if (schemaPath) args.push("--output-schema", schemaPath);
  if (req.writeAccess) args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (!resume) args.push("--sandbox", "read-only");
  if (!resume) args.push("--cd", req.workspaceDir!);
  args.push("-");
  return args;
}

function errorText(event: CodexEvent): string {
  if (typeof event.error === "string") return event.error;
  return event.error?.message ?? event.message ?? "Codex run failed";
}

function toolText(item: CodexItem): string | undefined {
  if (item.type === "command_execution") {
    return item.command ? `Bash: ${item.command.slice(0, 200)}` : "Bash";
  }
  if (item.type === "file_change") {
    const files = item.changes?.flatMap((change) =>
      change.path ? [change.path] : []
    );
    return files?.length ? `Edit: ${files.join(", ").slice(0, 200)}` : "Edit files";
  }
  if (item.type === "mcp_tool_call") {
    const name = [item.server, item.name].filter(Boolean).join(": ");
    return name ? `MCP: ${name}` : "MCP tool";
  }
  if (item.type === "web_search") {
    return item.query ? `Web search: ${item.query.slice(0, 200)}` : "Web search";
  }
  if (item.type === "plan") return "Update plan";
}

function parseStructured(text: string):
  | { ok: true; value: unknown }
  | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      message: `Codex returned invalid structured output: ${String(err)}`,
    };
  }
}

/** Codex's documented JSONL mode supplies session, progress, tool, and final
 * message events while auth stays entirely inside the local Codex CLI. */
export async function* streamCodexAgent(
  req: AgentRequest
): AsyncGenerator<AgentEvent> {
  let schemaDir: string | undefined;
  let schemaPath: string | undefined;
  if (req.outputSchema) {
    schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-codex-schema-"));
    schemaPath = path.join(schemaDir, "schema.json");
    fs.writeFileSync(schemaPath, JSON.stringify(req.outputSchema));
  }

  const executable = process.env.AUTOPROJECT_CODEX_PATH?.trim() || "codex";
  const child = spawn(/* turbopackIgnore: true */ executable, codexArgs(req, schemaPath), {
    cwd: req.workspaceDir,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let spawnError: Error | undefined;
  let stderr = "";
  let finalText = "";
  let resultSent = false;
  const seenTools = new Set<string>();

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(req.prompt);

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    child.kill("SIGINT");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 8000);
    killTimer.unref?.();
  };
  if (req.signal.aborted) onAbort();
  req.signal.addEventListener("abort", onAbort);

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("error", (err) => {
        spawnError = err;
        resolve({ code: null, signal: null });
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    }
  );

  try {
    const lines = readline.createInterface({ input: child.stdout });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event: CodexEvent;
      try {
        event = JSON.parse(line) as CodexEvent;
      } catch {
        continue;
      }

      if (event.type === "thread.started" && event.thread_id) {
        yield {
          type: "init",
          sessionId: tagSession("codex", event.thread_id),
        };
      } else if (event.type === "item.completed" && event.item) {
        if (event.item.type === "agent_message" && event.item.text?.trim()) {
          finalText = event.item.text;
          yield { type: "text", text: event.item.text };
        } else {
          const text = toolText(event.item);
          const key = event.item.id ?? `${event.item.type}:${text}`;
          if (text && !seenTools.has(key)) {
            seenTools.add(key);
            yield { type: "tool", text };
          }
        }
      } else if (event.type === "item.started" && event.item) {
        const text = toolText(event.item);
        const key = event.item.id ?? `${event.item.type}:${text}`;
        if (text && !seenTools.has(key)) {
          seenTools.add(key);
          yield { type: "tool", text };
        }
      } else if (event.type === "turn.completed") {
        resultSent = true;
        if (req.outputSchema) {
          const parsed = parseStructured(finalText);
          yield parsed.ok
            ? {
                type: "result",
                ok: true,
                text: finalText,
                structuredOutput: parsed.value,
              }
            : { type: "result", ok: false, text: parsed.message };
        } else {
          yield { type: "result", ok: true, text: finalText };
        }
      } else if (event.type === "turn.failed" || event.type === "error") {
        resultSent = true;
        yield { type: "result", ok: false, text: errorText(event) };
      }
    }

    const status = await exit;
    if (!resultSent) {
      const detail = spawnError
        ? spawnError.message
        : req.signal.aborted
          ? "Agent stopped"
          : stderr.trim() ||
            `Codex exited ${status.signal ? `with ${status.signal}` : `with code ${status.code}`}`;
      yield {
        type: "error",
        message: spawnError?.message.includes("ENOENT")
          ? "Codex CLI was not found. Install it, run `codex login`, and restart AutoProject."
          : detail,
      };
    }
  } finally {
    req.signal.removeEventListener("abort", onAbort);
    if (killTimer) clearTimeout(killTimer);
    if (schemaDir) fs.rmSync(schemaDir, { recursive: true, force: true });
  }
}
