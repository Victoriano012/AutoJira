import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { resumableSession, tagSession } from "../agent-session";
import type { AgentEvent, AgentRequest } from "./agent";

interface AgyToolInfo {
  name?: string;
  parameters?: Record<string, unknown>;
}

interface AgyStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  text_delta?: string;
  tool_name?: string;
  tool_info?: AgyToolInfo;
  duration_seconds?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

interface AgyResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  structured_output?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

interface AgyEvent {
  event?: string;
  conversation_id?: string;
  step_update?: AgyStepUpdate;
  result?: AgyResult;
}

/** Kept separate and exported so the CLI contract can be tested without
 * starting a model run. */
export function geminiArgs(
  req: Pick<
    AgentRequest,
    "model" | "sessionId" | "workspaceDir" | "writeAccess"
  >,
  schemaPath?: string
): string[] {
  const model = req.model!;
  const resume = resumableSession(req.sessionId, model);
  const args = ["--output-format", "stream-json"];
  if (resume) args.push("--conversation", resume.raw);
  args.push("--model", model);
  if (
    !model.endsWith("-high") &&
    !model.endsWith("-medium") &&
    !model.endsWith("-low")
  ) {
    args.push("--effort", "high");
  }
  if (schemaPath) args.push("--json-schema", schemaPath);
  if (req.writeAccess) args.push("--dangerously-skip-permissions");
  return args;
}

function toolText(toolName?: string, toolInfo?: AgyToolInfo): string | undefined {
  const name = toolName ?? toolInfo?.name ?? "";
  const params = toolInfo?.parameters ?? {};
  if (name === "run_command") {
    return params.CommandLine ? `Bash: ${String(params.CommandLine).slice(0, 200)}` : "Bash";
  }
  if (name === "write_to_file") {
    return params.TargetFile ? `Write: ${String(params.TargetFile).slice(0, 200)}` : "Write file";
  }
  if (name === "replace_file_content" || name === "multi_replace_file_content") {
    return params.TargetFile ? `Edit: ${String(params.TargetFile).slice(0, 200)}` : "Edit file";
  }
  if (name === "view_file") {
    return params.AbsolutePath ? `Read: ${String(params.AbsolutePath).slice(0, 200)}` : "Read file";
  }
  if (name === "list_dir") {
    return params.DirectoryPath ? `List: ${String(params.DirectoryPath).slice(0, 200)}` : "List directory";
  }
  if (name === "grep_search") {
    return params.Query ? `Grep: ${String(params.Query).slice(0, 200)}` : "Grep";
  }
  if (name === "find_by_name") {
    return params.Pattern ? `Find: ${String(params.Pattern).slice(0, 200)}` : "Find";
  }
  if (name === "read_url_content") {
    return params.Url ? `URL: ${String(params.Url).slice(0, 200)}` : "Fetch URL";
  }
  if (name === "search_web") {
    return params.query ? `Web search: ${String(params.query).slice(0, 200)}` : "Web search";
  }
  if (name) {
    const firstVal = Object.values(params)[0];
    return typeof firstVal === "string" && firstVal.trim()
      ? `${name}: ${firstVal.slice(0, 200)}`
      : name;
  }
}

function parseStructured(text: string):
  | { ok: true; value: unknown }
  | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      message: `Gemini returned invalid structured output: ${String(err)}`,
    };
  }
}

/** Antigravity CLI's stream-json mode supplies session, progress, tool, and final
 * message events while auth stays inside the local CLI environment. */
export async function* streamGeminiAgent(
  req: AgentRequest
): AsyncGenerator<AgentEvent> {
  let schemaDir: string | undefined;
  let schemaPath: string | undefined;
  if (req.outputSchema) {
    schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoproject-gemini-schema-"));
    schemaPath = path.join(schemaDir, "schema.json");
    fs.writeFileSync(schemaPath, JSON.stringify(req.outputSchema));
  }

  const executable =
    process.env.AUTOPROJECT_AGY_PATH?.trim() ||
    process.env.AUTOPROJECT_GEMINI_PATH?.trim() ||
    "agy";
  const child = spawn(
    /* turbopackIgnore: true */ executable,
    [...geminiArgs(req, schemaPath), "--print", req.prompt],
    {
      cwd: req.workspaceDir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

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
      let event: AgyEvent;
      try {
        event = JSON.parse(line) as AgyEvent;
      } catch {
        continue;
      }

      if (event.event === "init" && event.conversation_id) {
        yield {
          type: "init",
          sessionId: tagSession("gemini", event.conversation_id),
        };
      } else if (event.event === "step_update" && event.step_update) {
        const step = event.step_update;
        if (step.step_type === "agent_response" && step.text_delta) {
          finalText += step.text_delta;
          yield { type: "text", text: step.text_delta };
        } else if (step.step_type === "tool") {
          const text = toolText(step.tool_name, step.tool_info);
          const key = `${step.step_index}:${text}`;
          if (text && !seenTools.has(key)) {
            seenTools.add(key);
            yield { type: "tool", text };
          }
        }
      } else if (event.event === "result" && event.result) {
        resultSent = true;
        const res = event.result;
        if (res.status === "SUCCESS") {
          const usage = res.usage
            ? {
                tokens:
                  (res.usage.input_tokens ?? 0) + (res.usage.output_tokens ?? 0),
              }
            : undefined;
          const responseText = res.response ?? finalText;
          if (req.outputSchema) {
            if (res.structured_output !== undefined) {
              yield {
                type: "result",
                ok: true,
                text: responseText,
                structuredOutput: res.structured_output,
                usage,
              };
            } else {
              const parsed = parseStructured(responseText);
              yield parsed.ok
                ? {
                    type: "result",
                    ok: true,
                    text: responseText,
                    structuredOutput: parsed.value,
                    usage,
                  }
                : { type: "result", ok: false, text: parsed.message, usage };
            }
          } else {
            yield {
              type: "result",
              ok: true,
              text: responseText,
              usage,
            };
          }
        } else {
          yield {
            type: "result",
            ok: false,
            text: res.error || res.response || "Gemini run failed",
          };
        }
      }
    }

    const status = await exit;
    if (!resultSent) {
      const detail = spawnError
        ? spawnError.message
        : req.signal.aborted
          ? "Agent stopped"
          : stderr.trim() ||
            `Gemini (agy) exited ${status.signal ? `with ${status.signal}` : `with code ${status.code}`}`;
      yield {
        type: "error",
        message: spawnError?.message.includes("ENOENT")
          ? "Antigravity CLI (agy) was not found. Install it, authenticate with your Gemini account, and restart AutoProject."
          : detail,
      };
    }
  } finally {
    req.signal.removeEventListener("abort", onAbort);
    if (killTimer) clearTimeout(killTimer);
    if (schemaDir) fs.rmSync(schemaDir, { recursive: true, force: true });
  }
}
