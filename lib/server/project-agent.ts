import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { selectedModel } from "../config";
import { providerForModel } from "../models";
import { isTicketDone, type ChatEntry, type Mode, type Project } from "../types";
import { streamAgent } from "./agent";
import { addTicketsToBoard, boardServer, REQUEST_SCHEMA } from "./board-tools";
import * as store from "./project-store";
import { ensureLoaded, notifyAgent, registry } from "./runs";

/**
 * The one agent behind a project: a single Claude session resumed on every
 * turn, told per turn whether it is planning tickets (panel) or doing the work
 * itself (act). Both modes write to one transcript, `Project.chat`, streamed to
 * the browser through the project feed; the browser only ever asks for a turn.
 */

/** Thrown when a turn is asked for while one is running: the route says 409. */
export class AgentBusyError extends Error {
  constructor() {
    super("The project agent is busy");
  }
}

export const ACT_AGENTS: Record<string, AgentDefinition> = {
  worker: {
    description:
      "Implements one self-contained coding subtask in the workspace and reports what changed.",
    prompt:
      "You are a focused engineer working inside the current repository. Do exactly the subtask you are given, then reply with a 2-4 sentence summary of the changes.",
    permissionMode: "bypassPermissions",
    maxTurns: 80,
    model: "inherit",
  },
  scout: {
    description: "Read-only exploration: find files, trace code paths, summarize.",
    prompt: "Explore the repository and answer precisely; never modify files.",
    tools: ["Read", "Grep", "Glob", "Bash"],
    permissionMode: "dontAsk",
    maxTurns: 40,
  },
};

/** The agent's standing role, appended to the system prompt every turn. */
export function systemAppend(project: Project): string {
  const description = project.description.trim();
  return [
    `You are the single agent behind the project '${project.name}'.` +
      (description ? ` ${description}${/[.!?]$/.test(description) ? "" : "."}` : ""),
    `You have two ways of working, told to you at the top of each message: PANEL — you plan; you never modify files; you turn the human's message into tickets with mcp__board__add_tickets and record standing preferences with mcp__board__set_notes. ACT — you do the work yourself in the workspace and use the Agent tool (subagent_type 'worker' for independent coding subtasks that can run in parallel, 'scout' for read-only exploration) and keep the coordinating work yourself. The conversation is continuous across both.`,
    project.notes.length
      ? `\nStanding instructions for this project (always apply):\n${project.notes
          .map((n) => `- ${n}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function boardState(project: Project): string {
  const open = project.tickets.filter((t) => !isTicketDone(t));
  return open.length
    ? `Unsolved tickets on the board:\n${open.map((t) => `- ${t.title} [${t.status}]`).join("\n")}`
    : `The board has no unsolved tickets.`;
}

export function panelPreamble(project: Project, message: string): string {
  return [
    `MODE: PANEL`,
    boardState(project),
    `Rules:
- Prefer fewer, larger tickets: one ticket per coherent change an agent can finish in one session. Work that is tightly coupled (same feature, same files, one depends on the other) is ONE ticket, never several.
- \`files\` lists every workspace-relative path the ticket will create or modify; the board runs tickets sharing a file one after another.
- If the message is a question, a preference or needs no code, call add_tickets with [] (or not at all) and answer in one or two sentences. If it states a lasting preference ('always use pnpm', 'never touch /legacy'), call set_notes with the full updated list.
- Do not modify files in this mode.`,
    `Human:\n${message}`,
  ].join("\n\n");
}

export function actPreamble(project: Project, message: string): string {
  const running = project.tickets.filter((t) => t.status === "running");
  return [
    `MODE: ACT`,
    boardState(project),
    running.length
      ? `Ticket agents are working right now; leave their files alone:\n${running
          .map((t) => `- ${t.title}: ${t.files?.length ? t.files.join(", ") : "(no files listed)"}`)
          .join("\n")}`
      : "",
    `Human:\n${message}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function say(dir: string, mode: Mode, entry: Omit<ChatEntry, "ts" | "mode">) {
  store.appendChat(dir, [{ ...entry, ts: Date.now(), mode }]);
}

/** Start one turn of the project agent. Resolves when the turn is over; the
 * reply itself travels through the project feed. Throws `AgentBusyError`
 * synchronously if a turn is already running. */
export function sendToAgent(dir: string, mode: Mode, message: string): Promise<void> {
  if (registry.agents.has(dir)) throw new AgentBusyError();
  if (!ensureLoaded(dir)) throw new Error(`No project at ${dir}`);
  const ctrl = new AbortController();
  registry.agents.set(dir, ctrl);
  registry.agentMode.set(dir, mode);
  say(dir, mode, { kind: "user", text: message });
  notifyAgent(dir);
  return turn(dir, mode, message, ctrl.signal).finally(() => {
    registry.agents.delete(dir);
    registry.agentMode.delete(dir);
    notifyAgent(dir);
  });
}

export function stopAgent(dir: string): void {
  registry.agents.get(dir)?.abort();
}

async function turn(dir: string, mode: Mode, message: string, signal: AbortSignal) {
  const model = selectedModel();
  const provider = providerForModel(model);
  // Codex and Gemini have no in-process MCP: their panel turn answers with
  // the ticket list as structured output instead of calling the board tool.
  const fallback = mode === "panel" && provider !== "claude";

  const attempt = async (fresh: boolean): Promise<"done" | "retry"> => {
    const project = store.getProject(dir)!;
    const prompt =
      (mode === "panel" ? panelPreamble : actPreamble)(project, message) +
      (fallback
        ? `\n\nYou have no board tools here: answer with the JSON object of tickets instead.`
        : "");
    const sessionId = fresh ? undefined : project.agentSessionId;
    // Nothing said yet when a resumed turn fails means the resume itself did.
    let produced = false;
    let failed: string | null = null;
    try {
      const events = streamAgent({
        workspaceDir: project.workspaceDir,
        prompt,
        sessionId,
        signal,
        model,
        writeAccess: mode === "act",
        maxTurns: mode === "act" ? 150 : 12,
        systemPromptAppend: systemAppend(project),
        mcpServers: mode === "panel" ? { board: boardServer(dir) } : undefined,
        disallowedTools:
          mode === "panel" ? ["Edit", "Write", "MultiEdit", "NotebookEdit", "Task"] : undefined,
        forwardSubagentText: mode === "act",
        agents: mode === "act" ? ACT_AGENTS : undefined,
        outputSchema: fallback ? REQUEST_SCHEMA : undefined,
      });
      for await (const ev of events) {
        if (ev.type === "init") {
          store.setAgentSession(dir, ev.sessionId);
        } else if (ev.type === "text" || ev.type === "tool") {
          produced = true;
          say(dir, mode, { kind: ev.type, text: ev.sub ? `  ↳ ${ev.text}` : ev.text });
        } else if (ev.type === "result") {
          if (!ev.ok) failed = ev.text;
          else if (fallback && ev.structuredOutput) {
            const { tickets } = ev.structuredOutput as {
              tickets: { title: string; description: string; files: string[] }[];
            };
            addTicketsToBoard(dir, tickets);
          }
        } else if (ev.type === "error") {
          failed = ev.message;
        }
      }
    } catch (err) {
      failed = String(err);
    }
    if (signal.aborted) {
      say(dir, mode, { kind: "info", text: "Stopped by user" });
      return "done";
    }
    if (failed === null) return "done";
    // The stored session can be gone (a wiped ~/.claude, another machine's
    // id): forget it and start the conversation over, once.
    if (sessionId && !produced) return "retry";
    say(dir, mode, { kind: "error", text: failed });
    return "done";
  };

  if ((await attempt(false)) === "retry") {
    store.setAgentSession(dir, undefined);
    await attempt(true);
  }
}
