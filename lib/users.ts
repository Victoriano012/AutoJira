import { sql } from "./db";

let ensured: Promise<unknown> | null = null;
function ensureSchema() {
  if (!ensured) {
    ensured = sql()`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT
      )`.catch((e) => {
      ensured = null;
      throw e;
    });
  }
  return ensured;
}

export async function getOrCreateUser(
  email: string,
  name: string | null
): Promise<number> {
  await ensureSchema();
  const rows = await sql()`
    INSERT INTO users (email, name) VALUES (${email.toLowerCase()}, ${name})
    ON CONFLICT (email) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)
    RETURNING id`;
  return rows[0].id as number;
}
