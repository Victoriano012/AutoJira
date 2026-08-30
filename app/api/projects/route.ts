import { createProject, importProject, listProjects } from "@/lib/projects-fs";

export async function GET() {
  return Response.json({ projects: listProjects() });
}

/** {name} creates a new folder under the base dir; {path} imports any folder. */
export async function POST(req: Request) {
  const { name, path } = (await req.json()) as { name?: string; path?: string };
  try {
    const row = path ? importProject(path) : createProject(name || "Untitled project");
    return Response.json(row);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
