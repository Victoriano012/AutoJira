import { eraseProject, hideProject } from "@/lib/projects-fs";
import { forget, getProject, setProject } from "@/lib/server/project-store";
import { autoRunBoards, ensureLoaded, ownsTicket } from "@/lib/server/runs";
import { applyRunEdits, mergeRunState, RunEdit } from "@/lib/run-state";
import { Project } from "@/lib/types";

// id = URL-encoded absolute path of the workspace folder
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const dir = decodeURIComponent(id);
  // Loading through the server store both serves live run state and settles
  // whatever a dead process left marked running.
  const project = ensureLoaded(dir);
  if (!project) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: dir, name: project.name, data: project });
}

/**
 * The browser's autosave. It owns structure and user fields; the server owns
 * every run-produced field (status, log, sessionId, resultSummary), so those
 * are taken from the server's copy rather than the payload. Deliberate changes
 * to a run field (Reopen, a chat session) arrive as `edits` and are applied
 * unless a live run owns that ticket.
 */
export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const dir = decodeURIComponent(id);
  if (!ensureLoaded(dir)) return Response.json({ error: "Not found" }, { status: 404 });
  const { data, edits } = (await req.json()) as { data: Project; edits?: RunEdit[] };
  // Read the server's copy after the body, not before: a run writing during the
  // parse would otherwise be merged away by a snapshot taken too early.
  const current = getProject(dir);
  if (!current) return Response.json({ error: "Not found" }, { status: 404 });
  const merged = applyRunEdits(
    mergeRunState(data, current),
    edits ?? [],
    (path, ticketId) => ownsTicket(dir, path, ticketId)
  );
  setProject(dir, merged);
  // The autosave is how new cards reach the server. A card that can run should
  // be running, not queued behind the next time somebody presses run.
  autoRunBoards(dir);
  return Response.json({ ok: true });
}

/** ?mode=hide (default) hides from the meta-graph; ?mode=erase deletes the
 * whole workspace folder from disk. */
export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const dir = decodeURIComponent(id);
  const mode = new URL(req.url).searchParams.get("mode");
  if (mode === "erase") {
    forget(dir);
    eraseProject(dir);
  } else {
    // Write "hidden" through the store when it holds this project, so a
    // pending flush cannot resurrect the old copy.
    const held = getProject(dir);
    if (held) setProject(dir, { ...held, hidden: true });
    else hideProject(dir);
  }
  return Response.json({ ok: true });
}
