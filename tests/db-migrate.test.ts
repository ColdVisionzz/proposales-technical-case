import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { loadDotEnv, requireEnv } from "../lib/db/env";
import { migrate } from "../lib/db/migrate";

// Runs against a throwaway Neon branch (DATABASE_URL_TEST). It drops tables, so it refuses to touch the live database.
let url: string;
let sql: postgres.Sql;

const host = (u: string) => new URL(u).hostname.replace("-pooler", "");

beforeAll(() => {
  loadDotEnv();
  url = requireEnv("DATABASE_URL_TEST"); // fails loudly when unset, never skips silently
  for (const live of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
    if (process.env[live] && host(process.env[live]) === host(url)) {
      throw new Error(`DATABASE_URL_TEST points at the same database as ${live}. Use a separate Neon branch.`);
    }
  }
  sql = postgres(url, { max: 1, onnotice: () => {} });
});

beforeEach(async () => {
  await sql`DROP TABLE IF EXISTS events, enquiries, schema_migrations, half_done, probe CASCADE`;
});

afterAll(async () => {
  await sql?.end();
});

const insert = (messageId: string, source = "email", body: string | null = null) =>
  sql`INSERT INTO enquiries (message_id, source, raw_body) VALUES (${messageId}, ${source}, ${body})`;

const tempMigrations = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "migrations-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};

describe("migration runner", () => {
  test("applies every migrations/*.sql once, in order, and is a no-op the second time", async () => {
    const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    expect(await migrate(url)).toEqual(files);
    expect(await migrate(url)).toEqual([]);
    const rows = await sql`SELECT name FROM schema_migrations ORDER BY name`;
    expect(rows.map((r) => r.name)).toEqual(files);
  });

  test("a migration that fails halfway leaves nothing behind and is not recorded", async () => {
    const dir = tempMigrations({ "001_bad.sql": "CREATE TABLE half_done (id int); SELECT 1/0;" });
    await expect(migrate(url, dir)).rejects.toThrow();
    const [{ t }] = await sql`SELECT to_regclass('half_done') AS t`;
    expect(t).toBeNull();
    expect(await sql`SELECT name FROM schema_migrations`).toHaveLength(0);
  });

  // The file succeeds, then the runner's own bookkeeping insert fails (the file already recorded its name).
  // Only a shared transaction undoes the file's work; this test fails if file and record are committed separately.
  test("the migration and its bookkeeping row commit or roll back together", async () => {
    const dir = tempMigrations({
      "001_probe.sql": "CREATE TABLE probe (id int); INSERT INTO schema_migrations (name) VALUES ('001_probe.sql');",
    });
    await expect(migrate(url, dir)).rejects.toThrow();
    const [{ t }] = await sql`SELECT to_regclass('probe') AS t`;
    expect(t).toBeNull();
  });
});

describe("enquiries schema", () => {
  beforeEach(async () => {
    await migrate(url);
  });

  test("defaults to queued with no attempts", async () => {
    await insert("<a@x>");
    const [row] = await sql`SELECT status, attempts, version, override FROM enquiries`;
    expect(row).toEqual({ status: "queued", attempts: 0, version: 0, override: false });
  });

  test("a duplicate message_id is rejected, and ON CONFLICT DO NOTHING keeps one row", async () => {
    await insert("<dup@x>");
    await expect(insert("<dup@x>")).rejects.toThrow(/unique/i);
    await sql`INSERT INTO enquiries (message_id, source) VALUES ('<dup@x>', 'email') ON CONFLICT (message_id) DO NOTHING`;
    expect(await sql`SELECT 1 FROM enquiries`).toHaveLength(1);
  });

  test("an unknown status is rejected", async () => {
    await insert("<s@x>");
    await expect(sql`UPDATE enquiries SET status = 'done'`).rejects.toThrow(/check/i);
  });

  test("an unknown source is rejected", async () => {
    await expect(insert("<src@x>", "fax")).rejects.toThrow(/check/i);
  });

  test("a paste row without a body is rejected, an email row without one is allowed", async () => {
    await expect(insert("<p@x>", "paste", null)).rejects.toThrow(/paste_has_body/);
    await insert("<e@x>", "email", null);
    await insert("<p2@x>", "paste", "hello");
    expect(await sql`SELECT 1 FROM enquiries`).toHaveLength(2);
  });

  test("an event must belong to an existing enquiry", async () => {
    await expect(
      sql`INSERT INTO events (enquiry_id, step, outcome) VALUES (gen_random_uuid(), 'extract', 'ok')`,
    ).rejects.toThrow(/foreign key/i);
  });
});
