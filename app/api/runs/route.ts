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
    | "runProject"
    | "stopTicket"
    | "stopProject"
    | "sendFeedback"
    | "noteTicket"
    | "approveTicket"
    | "rejectTicket"
    | "settleZombies"
    | "removeTickets";
  ticketId?: string;
  /** removeTickets */
  ticketIds?: string[];
  message?: string;
}

export async function POST(req: Request) {
  const body = (await req.json()) as RunRequest;
  const { dir, action } = body;
  const id = body.ticketId ?? "";
  if (!dir || !runs.ensureLoaded(dir)) {
    return Response.json({ error: "Unknown project" }, { status: 404 });
  }

  try {
    switch (action) {
      case "runTicket":
        await runs.runTicket(dir, id);
        break;
      case "runProject":
        await runs.runProject(dir);
        break;
      case "sendFeedback":
        await runs.sendFeedback(dir, id, body.message ?? "");
        break;
      case "noteTicket":
        runs.noteTicket(dir, id, body.message ?? "");
        break;
      case "rejectTicket":
        await runs.rejectTicket(dir, id, body.message ?? "");
        break;
      case "approveTicket":
        runs.approveTicket(dir, id);
        break;
      case "stopTicket":
        runs.stopTicket(dir, id);
        break;
      case "stopProject":
        runs.stopProject(dir, true);
        break;
      case "settleZombies":
        runs.settleZombies(dir);
        break;
      case "removeTickets":
        runs.removeTickets(dir, body.ticketIds ?? []);
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
