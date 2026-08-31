import { resumableSession } from "@/lib/agent-session";
import { selectedModel } from "@/lib/config";
import { runAgent } from "@/lib/server/agent";
import fs from "fs";
import os from "os";
import path from "path";

export const maxDuration = 300;

// Side chat with a ticket's main agent (the project root counts as the
// outermost ticket). The caller passes the ticket's own work session so the
// agent already knows what it did; without one, the first message starts a
// session that becomes the ticket's.
export async function POST(req: Request) {
  const {
    message,
    sessionId,
    workspaceDir,
    projectName,
    ticketTitle,
    ticketDescription,
    graphSummary,
  } = (await req.json()) as {
    message: string;
    /** The ticket's agent session; omitted if it never ran. */
    sessionId?: string;
    workspaceDir?: string;
    projectName?: string;
    /** Set when chatting inside a ticket; unset at the project root. */
    ticketTitle?: string;
    ticketDescription?: string;
    /** Compact list of the tickets on the board the user is looking at. */
    graphSummary?: string;
  };

  const cwd =
    workspaceDir?.trim() ||
    process.env.AUTOJIRA_WORKSPACE ||
    path.join(os.tmpdir(), "autojira-workspace");
  fs.mkdirSync(cwd, { recursive: true });
  const model = selectedModel();
  const activeSession = resumableSession(sessionId, model)?.stored;

  const intro = ticketTitle
    ? [
        `You are the main agent of the ticket "${ticketTitle}" in the project "${projectName ?? path.basename(cwd)}", which lives in the current working directory.`,
        ticketDescription && `Ticket description:\n${ticketDescription}`,
        `The human chats with you here about this ticket — questions, running commands, starting a dev server so they can see the result, quick fixes. Actually do what they ask with your tools; don't just describe how.`,
      ]
        .filter(Boolean)
        .join("\n")
    : `You are the main agent of the project "${projectName ?? path.basename(cwd)}", which lives in the current working directory, where AI agents execute its tickets. The human chats with you here for anything the tickets don't cover — questions about the project, running commands, starting a dev server so they can see the result, quick fixes. Actually do what they ask with your tools; don't just describe how.`;

  const prompt = [
    activeSession
      ? `Message from the human in your ticket's side chat (current board state below).`
      : intro,
    graphSummary && `\nTickets on this level's board right now:\n${graphSummary}`,
    `\nHuman:\n${message}`,
    `\nEnd your reply with a short message to the human: what you did, or the answer to their question.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const result = await runAgent({
      prompt,
      workspaceDir: cwd,
      sessionId: activeSession,
      signal: req.signal,
      model,
      writeAccess: true,
      maxTurns: 150,
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
