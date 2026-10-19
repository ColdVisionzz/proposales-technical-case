import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadDotEnv, requireEnv } from "../lib/db/env";
import { migrate } from "../lib/db/migrate";

// The code under test calls db(); here it returns the test branch connection.
let current: postgres.Sql;
vi.mock("../lib/db/client", () => ({ db: () => current }));

import { PATCH } from "../app/api/enquiries/[id]/route";
import { claimEnquiry, editExtraction, insertEnquiry } from "../lib/db/enquiries";
import { clean, email } from "./extraction.fixtures";

let sql: postgres.Sql;
const host = (u: string) => new URL(u).hostname.replace("-pooler", "");

beforeAll(async () => {
  loadDotEnv();
  const url = requireEnv("DATABASE_URL_TEST");
  for (const live of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"]) {
    if (process.env[live] && host(process.env[live]) === host(url)) {
      throw new Error(`DATABASE_URL_TEST points at the same database as ${live}. Use a separate Neon branch.`);
    }
  }
  // 20 connections: the parallel-claim test needs all 20 statements in flight at once.
  sql = postgres(url, { max: 20, onnotice: () => {} });
  current = sql;
  await sql`DROP TABLE IF EXISTS events, enquiries, schema_migrations CASCADE`;
  await migrate(url);
});

beforeEach(async () => {
  await sql`TRUNCATE enquiries, events CASCADE`;
});

afterAll(async () => {
  await sql?.end();
});

let counter = 0;
const addPaste = async () =>
  (await insertEnquiry({ messageId: `paste:${counter++}`, source: "paste", subject: email.subject, body: email.body })).id;
const row = async (id: string) => (await sql`SELECT * FROM enquiries WHERE id = ${id}`)[0];
const setStatus = (id: string, status: string) => sql`UPDATE enquiries SET status = ${status} WHERE id = ${id}`;

// ---- Guarantee 2: twenty claims at once ---------------------------------------------------------------------------

describe("the claim under load", () => {
  test("20 claims at the same moment: exactly one wins, the row is claimed once", async () => {
    const id = await addPaste();
    const results = await Promise.all(Array.from({ length: 20 }, () => claimEnquiry(id)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.find((r) => r !== null)).toMatchObject({ attempt: 1 });
    expect(await row(id)).toMatchObject({ status: "processing", attempts: 1 });
  });
});

// ---- Guarantee 3: version-checked human edits ---------------------------------------------------------------------

describe("editExtraction", () => {
  test("a current-version edit saves and bumps the version", async () => {
    const id = await addPaste();
    await setStatus(id, "needs_review");
    expect(await editExtraction(id, clean(), 0)).toEqual({ ok: true, version: 1 });
    expect(await row(id)).toMatchObject({ version: 1, extracted: clean() });
  });

  test("a stale version changes nothing and returns the current row", async () => {
    const id = await addPaste();
    await setStatus(id, "needs_review");
    await editExtraction(id, clean(), 0); // someone else saved first: version is now 1
    const edit = clean({ guests: { value: 99, confidence: 1, evidence: "99" } as never });
    const result = await editExtraction(id, edit, 0); // this editor still thinks version 0
    expect(result).toMatchObject({ ok: false, current: { status: "needs_review", version: 1, extracted: clean() } });
    expect(await row(id)).toMatchObject({ version: 1, extracted: clean() });
  });

  test("two edits at the same version at the same moment: exactly one wins", async () => {
    const id = await addPaste();
    await setStatus(id, "needs_review");
    const results = await Promise.all(Array.from({ length: 10 }, () => editExtraction(id, clean(), 0)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await row(id)).version).toBe(1);
  });

  test.each(["queued", "processing", "retrying", "draft_created", "failed_permanent", "ignored"])(
    "a %s row is not editable, so a human edit never races a worker",
    async (status) => {
      const id = await addPaste();
      await setStatus(id, status);
      expect(await editExtraction(id, clean(), 0)).toMatchObject({ ok: false, current: { status, version: 0 } });
      expect(await row(id)).toMatchObject({ version: 0, extracted: null });
    },
  );
});

// ---- PATCH /api/enquiries/[id] -----------------------------------------------------------------------------------

const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://test/api/enquiries/${id}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const MISSING = "0b9f4c2e-6d1a-4f4e-9a52-3c1d2e7a8b90";

describe("PATCH /api/enquiries/[id]", () => {
  test("200 with the new version", async () => {
    const id = await addPaste();
    await setStatus(id, "needs_review");
    const res = await patch(id, { extracted: clean(), version: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1 });
  });

  test("409 with the current data when the version is stale, and nothing is overwritten", async () => {
    const id = await addPaste();
    await setStatus(id, "needs_review");
    await patch(id, { extracted: clean(), version: 0 });
    const res = await patch(id, { extracted: clean(), version: 0 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", current: { status: "needs_review", version: 1, extracted: clean() } });
    expect((await row(id)).version).toBe(1);
  });

  test("404 for an unknown id", async () => {
    expect((await patch(MISSING, { extracted: clean(), version: 0 })).status).toBe(404);
  });

  test.each([
    ["an id that is not a uuid", "nope", { extracted: clean(), version: 0 }],
    ["a missing version", MISSING, { extracted: clean() }],
    ["a fractional version", MISSING, { extracted: clean(), version: 0.5 }],
    ["an extraction that does not fit the schema", MISSING, { extracted: { nonsense: true }, version: 0 }],
  ])("400 for %s", async (_name, id, body) => {
    expect((await patch(id, body)).status).toBe(400);
  });
});
