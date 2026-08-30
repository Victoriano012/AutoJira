import { neon } from "@neondatabase/serverless";

type Sql = (
  strings: TemplateStringsArray,
  ...params: unknown[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Promise<Record<string, any>[]>;

let _sql: Sql | null = null;

/** Lazy so `next build` doesn't require DATABASE_URL. */
export function sql(): Sql {
  if (!_sql) _sql = neon(process.env.DATABASE_URL!) as unknown as Sql;
  return _sql;
}
