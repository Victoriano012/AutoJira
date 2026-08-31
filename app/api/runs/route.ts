import * as runs from "@/lib/server/runs";

export const dynamic = "force-dynamic";

/**
 * Every run action, executed in the server process. The work is deliberately
 * not tied to `req.signal`: a run keeps going (and keeps writing its progress)
 * when the browser tab that started it reloads or closes. The response, when
 * anyone is still listening, arrives once the action settles.
 */
export interface RunRequest {
  dir: string;
  action:
    | "runTicket"
    | "runGraph"
    | "stopTicket"
    | "stopGraph"
    | "sendFeedback"
    | "approveTicket"
    | "rejectTicket"
    | "settleZombies";
  path?: string[];
  ticketId?: string;
  message?: string;
}

export async function POST(req: Request) {
  const body = (await req.json()) as RunRequest;
  const { dir, action } = body;
  const path = body.path ?? [];
  const id = body.ticketId ?? "";
  if (!dir || !runs.ensureLoaded(dir)) {
    return Response.json({ error: "Unknown project" }, { status: 404 });
  }

  try {
    switch (action) {
      case "runTicket":
        await runs.runTicket(dir, path, id);
        break;
      case "runGraph":
        await runs.runGraph(dir, path);
        break;
      case "sendFeedback":
        await runs.sendFeedback(dir, path, id, body.message ?? "");
        break;
      case "rejectTicket":
        await runs.rejectTicket(dir, path, id, body.message ?? "");
        break;
      case "approveTicket":
        runs.approveTicket(dir, path, id);
        break;
      case "stopTicket":
        runs.stopTicket(dir, path, id);
        break;
      case "stopGraph":
        runs.stopGraph(dir, path);
        break;
      case "settleZombies":
        runs.settleZombies(dir, path);
        break;
      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err), runs: runs.runState(dir) },
      { status: 500 }
    );
  }
  return Response.json({ ok: true, runs: runs.runState(dir) });
}

/** Which runs are actually live right now — the truth a reloaded tab needs. */
export async function GET(req: Request) {
  const dir = new URL(req.url).searchParams.get("dir") ?? "";
  if (!dir || !runs.ensureLoaded(dir)) {
    return Response.json({ error: "Unknown project" }, { status: 404 });
  }
  return Response.json({ runs: runs.runState(dir) });
}
