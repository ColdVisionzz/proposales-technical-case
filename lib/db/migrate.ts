import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

// Applies every .sql file in `dir` that is not recorded in schema_migrations, in filename order.
// Each file and its bookkeeping row share one transaction, so "recorded" and "applied" cannot disagree:
// if the file fails, nothing from it is kept and it is retried on the next run.
// Known limit: two runners at the same moment could both apply a file (one then fails on the primary key).
export async function migrate(url: string, dir = "migrations"): Promise<string[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const done = new Set((await sql`SELECT name FROM schema_migrations`).map((r) => r.name as string));
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const name of files) {
      if (done.has(name)) continue;
      const text = readFileSync(join(dir, name), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
      });
      applied.push(name);
    }
    return applied;
  } finally {
    await sql.end();
  }
}
