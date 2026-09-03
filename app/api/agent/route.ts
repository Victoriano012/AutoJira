import {
  cancelRequest,
  retryRequest,
  sendToAgent,
  stopAgent,
} from "@/lib/server/project-agent";
import type { Mode } from "@/lib/types";

type AgentRequestBody =
  | { dir: string; action: "send"; mode: Mode; message: string }
  | { dir: string; action: "stop" }
  | { dir: string; action: "cancel"; id: string }
  | { dir: string; action: "retry"; id: string };

// The turn runs in the server process and streams back through
// /api/runs/stream, so this only queues, stops or drops requests.
export async function POST(req: Request) {
  const body = (await req.json()) as AgentRequestBody;
  if (body.action === "stop") {
    stopAgent(body.dir);
    return new Response(null, { status: 204 });
  }
  if (body.action === "cancel") {
    cancelRequest(body.dir, body.id);
    return new Response(null, { status: 204 });
  }
  if (body.action === "retry") {
    retryRequest(body.dir, body.id);
    return new Response(null, { status: 204 });
  }
  try {
    sendToAgent(body.dir, body.mode, body.message);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 400 });
  }
  return new Response(null, { status: 202 });
}
