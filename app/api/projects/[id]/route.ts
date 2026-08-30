import { requireUserId } from "@/lib/auth-server";
import { sql } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const userId = await requireUserId();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const rows = await sql()`
    SELECT id, name, data, updated_at FROM projects
    WHERE id = ${id} AND user_id = ${userId}`;
  if (!rows[0]) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(rows[0]);
}

export async function PUT(req: Request, ctx: Ctx) {
  const userId = await requireUserId();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const { name, data } = await req.json();
  const rows = await sql()`
    UPDATE projects
    SET name = COALESCE(${name ?? null}, name),
        data = COALESCE(${data ? JSON.stringify(data) : null}::jsonb, data),
        updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id`;
  if (!rows[0]) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const userId = await requireUserId();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  await sql()`DELETE FROM projects WHERE id = ${id} AND user_id = ${userId}`;
  return Response.json({ ok: true });
}
