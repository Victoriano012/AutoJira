import { requireUserId } from "@/lib/auth-server";
import { sql } from "@/lib/db";

export async function GET() {
  const userId = await requireUserId();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await sql()`
    SELECT id, name, updated_at FROM projects
    WHERE user_id = ${userId} ORDER BY updated_at DESC`;
  return Response.json({ projects: rows });
}

export async function POST(req: Request) {
  const userId = await requireUserId();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { name, data } = await req.json();
  const rows = await sql()`
    INSERT INTO projects (user_id, name, data)
    VALUES (${userId}, ${name || "Untitled project"}, ${JSON.stringify(data ?? {})})
    RETURNING id, name, updated_at`;
  return Response.json(rows[0]);
}
