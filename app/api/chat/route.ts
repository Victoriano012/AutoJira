import { modelOption } from "@/lib/config";
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "fs";
import os from "os";
import path from "path";

export const maxDuration = 300;

// General project chat: an agent with full tool access working in the
// project's workspace dir, aware of the current board. One conversation per
// project — the caller passes back the sessionId and we resume it.
export async function POST(req: Request) {
  const { message, sessionId, workspaceDir, projectName, graphSummary } =
    (await req.json()) as {
      message: string;
      /** Session of this project's chat; omitted on the first message. */
      sessionId?: string;
      workspaceDir?: string;
      projectName?: string;
      /** Compact list of the tickets on the board the user is looking at. */
      graphSummary?: string;
    };

  const cwd =
    workspaceDir?.trim() ||
    process.env.AUTOJIRA_WORKSPACE ||
    path.join(os.tmpdir(), "autojira-workspace");
  fs.mkdirSync(cwd, { recursive: true });

  const prompt = [
    sessionId
      ? `Next message from the human (current board state below).`
      : `You are a hands-on assistant chatting with the human who runs the project "${projectName ?? path.basename(cwd)}". The project lives in the current working directory, where AI agents execute its tickets. The human uses this chat for anything the tickets don't cover — questions about the project, running commands, starting a dev server so they can see the result, quick fixes. Actually do what they ask with your tools; don't just describe how.`,
    graphSummary && `\nTickets on the board right now:\n${graphSummary}`,
    `\nHuman:\n${message}`,
    `\nEnd your reply with a short message to the human: what you did, or the answer to their question.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    let newSessionId: string | undefined;
    for await (const msg of query({
      prompt,
      options: {
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 150,
        ...modelOption(),
        ...(sessionId ? { resume: sessionId } : {}),
      },
    })) {
      if (msg.type === "system" && msg.subtype === "init") {
        newSessionId = msg.session_id;
      } else if (msg.type === "result") {
        if (msg.subtype === "success") {
          return Response.json({
            ok: !msg.is_error,
            text: msg.result,
            sessionId: newSessionId,
          });
        }
        return Response.json({
          ok: false,
          text: `Agent stopped: ${msg.subtype}`,
          sessionId: newSessionId,
        });
      }
    }
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
  return Response.json({ error: "No result from agent" }, { status: 502 });
}
