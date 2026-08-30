import { eraseProject, hideProject, readProject, writeProject } from "@/lib/projects-fs";
import { Project } from "@/lib/types";

// id = URL-encoded absolute path of the workspace folder
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const dir = decodeURIComponent(id);
  const project = readProject(dir);
  if (!project) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: dir, name: project.name, data: project });
}

export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const dir = decodeURIComponent(id);
  if (!readProject(dir)) return Response.json({ error: "Not found" }, { status: 404 });
  const { data } = (await req.json()) as { data: Project };
  writeProject(dir, data);
  return Response.json({ ok: true });
}

/** ?mode=hide (default) hides from the meta-graph; ?mode=erase deletes the
 * whole workspace folder from disk. */
export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const dir = decodeURIComponent(id);
  const mode = new URL(req.url).searchParams.get("mode");
  if (mode === "erase") eraseProject(dir);
  else hideProject(dir);
  return Response.json({ ok: true });
}
