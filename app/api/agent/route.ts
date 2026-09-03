import { AgentBusyError, sendToAgent, stopAgent } from "@/lib/server/project-agent";
import type { Mode } from "@/lib/types";

type AgentRequestBody =
  | { dir: string; action: "send"; mode: Mode; message: string }
  | { dir: string; action: "stop" };

// The turn runs in the server process and streams back through
// /api/runs/stream, so this only starts or stops it.
export async function POST(req: Request) {
  const body = (await req.json()) as AgentRequestBody;
  if (body.action === "stop") {
    stopAgent(body.dir);
    return new Response(null, { status: 204 });
  }
  try {
    void sendToAgent(body.dir, body.mode, body.message);
  } catch (err) {
    if (err instanceof AgentBusyError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    return Response.json({ error: String(err) }, { status: 400 });
  }
  return new Response(null, { status: 202 });
}
