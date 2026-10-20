import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadDotEnv, requireEnv } from "../lib/db/env";
import { migrate } from "../lib/db/migrate";

let current: postgres.Sql;
vi.mock("../lib/db/client", () => ({ db: () => current }));

// after() only works inside a real request: here it collects the callbacks. The nudge is stubbed.
const afterCallbacks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => void afterCallbacks.push(fn),
}));
vi.mock("../lib/queue", () => ({ nudge: vi.fn(async () => {}) }));
// The create-anyway route reads the catalog through the shared gateway; the test gives it the sample catalog.
vi.mock("../lib/pipeline/gateway", async () => {
  const { createFakeGateway } = await import("../lib/proposales/fake");
  const { catalog } = await import("./extraction.fixtures");
  return { getGateway: () => createFakeGateway(catalog).gateway };
});

import { PATCH } from "../app/api/enquiries/[id]/route";
import { POST as createAnywayRoute } from "../app/api/enquiries/[id]/create-anyway/route";
import { insertEnquiry } from "../lib/db/enquiries";
import { HAND_EVIDENCE } from "../lib/extraction/schema";
import { nudge } from "../lib/queue";
import { createFakeGateway } from "../lib/proposales/fake";
import { processEnquiry, type Deps } from "../lib/pipeline/process";
import { catalog, clean, email, f, TODAY } from "./extraction.fixtures";

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
  sql = postgres(url, { max: 5, onnotice: () => {} });
  current = sql;
  await sql`DROP TABLE IF EXISTS events, enquiries, settings, schema_migrations CASCADE`;
  await migrate(url);
});

beforeEach(async () => {
  await sql`TRUNCATE enquiries, events, settings CASCADE`;
  afterCallbacks.length = 0;
  vi.mocked(nudge).mockClear();
});

afterAll(async () => {
  await sql?.end();
});

// ---- helpers ----------------------------------------------------------------------------------------------------

const unknown = f<never>(null, null, 0);
// What the model leaves behind for a vague enquiry: no dates, no guest count.
const vague = () => clean({ startDate: unknown, endDate: unknown, guests: unknown, products: [] });

let counter = 0;
// A needs_review row holding the given extraction, exactly as the pipeline leaves it.
async function inReview(extracted: unknown = vague()) {
  const { id } = await insertEnquiry({
    messageId: `paste:${counter++}`,
    source: "paste",
    subject: email.subject,
    body: email.body,
    sender: "Anna Lindqvist <anna@northwind.example.com>",
  });
  await sql`UPDATE enquiries SET status = 'needs_review', extracted = ${sql.json(extracted as never)} WHERE id = ${id}`;
  return id;
}
const row = async (id: string) => (await sql`SELECT * FROM enquiries WHERE id = ${id}`)[0];
const call = (route: typeof PATCH | typeof createAnywayRoute, method: string, id: string, body: unknown) =>
  route(new Request(`http://test/api/enquiries/${id}`, { method, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const save = (id: string, changes: unknown, version: number) => call(PATCH, "PATCH", id, { changes, version });
const release = (id: string, version: number) => call(createAnywayRoute, "POST", id, { version });
const MISSING = "0b9f4c2e-6d1a-4f4e-9a52-3c1d2e7a8b90";

function setup() {
  const fake = createFakeGateway(catalog);
  const extract = vi.fn();
  const deps: Deps = {
    fetchBody: vi.fn(async () => ({ text: email.body, html: null })),
    extract: extract as unknown as Deps["extract"],
    gateway: fake.gateway,
    companyId: 1001,
    today: () => TODAY,
    schedule: vi.fn(async () => {}),
  };
  return { fake, extract, deps };
}

// ---- the whole flow ---------------------------------------------------------------------------------------------

describe("a vague enquiry, filled in by a person and released", () => {
  test("save, create anyway, process: one draft built from what they typed, no model call", async () => {
    const id = await inReview();
    expect((await save(id, { startDate: "2027-05-03", endDate: "2027-05-04", guests: 40, products: [3001] }, 0)).status).toBe(200);
    const released = await release(id, 1);
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ ok: true, version: 2 });
    expect(await row(id)).toMatchObject({ status: "queued", override: true, tries: 0 });
    expect(afterCallbacks).toHaveLength(1); // the worker is nudged after the response

    const { fake, extract, deps } = setup();
    expect(await processEnquiry(id, deps)).toBe("draft_created");
    expect(extract).not.toHaveBeenCalled(); // the saved extraction is reused
    expect(fake.drafts).toHaveLength(1);
    expect(fake.drafts[0].input.description_md).toContain("2027-05-03 to 2027-05-04");
    expect(fake.drafts[0].input.blocks).toEqual([expect.objectContaining({ content_id: 3001 })]);
    expect(await row(id)).toMatchObject({ status: "draft_created", override: true });
  });
});

describe("an email with no readable text", () => {
  test("lands in review, and once a person fills it in and releases it, it becomes a draft instead of bouncing back", async () => {
    const id = await inReview(null);
    await sql`UPDATE enquiries SET raw_body = '' WHERE id = ${id}`;
    await save(id, { startDate: "2027-05-03", endDate: "2027-05-04", guests: 40 }, 0);
    expect((await release(id, 1)).status).toBe(200);

    const { fake, deps } = setup();
    expect(await processEnquiry(id, deps)).toBe("draft_created");
    expect(fake.drafts).toHaveLength(1);
  });

  test("the same empty row without a release still goes to review", async () => {
    const id = await inReview(null);
    await sql`UPDATE enquiries SET raw_body = '', status = 'queued' WHERE id = ${id}`;
    const { fake, deps } = setup();
    expect(await processEnquiry(id, deps)).toBe("needs_review");
    expect(fake.drafts).toHaveLength(0);
  });
});

describe("a masked address is never saved", () => {
  test("PATCH with masked text is a 400 and the database is unchanged", async () => {
    const real = "Call anna.berg@acme.com after 5";
    const id = await inReview(clean({ specialRequests: f(real, real) }));
    const res = await save(id, { specialRequests: "Call a***@a***.com after 6" }, 0); // what the screen showed, edited around
    expect(res.status).toBe(400);
    expect(await row(id)).toMatchObject({ version: 0 });
    expect((await row(id)).extracted.specialRequests.value).toBe(real);
  });
});

describe("the pipeline under override", () => {
  const release_ = async (extracted: unknown) => {
    const id = await inReview(extracted);
    await sql`UPDATE enquiries SET status = 'queued', override = true WHERE id = ${id}`;
    return id;
  };

  test("a row that reaches the worker without a guest count goes back to needs_review", async () => {
    const id = await release_(clean({ guests: unknown, startDate: f("2027-05-03", HAND_EVIDENCE) }));
    const { fake, deps } = setup();
    expect(await processEnquiry(id, deps)).toBe("needs_review");
    expect(fake.drafts).toHaveLength(0);
    expect((await row(id)).flags.reasons.join(" ")).toMatch(/Guest count/);
  });

  test("a date in the past that a person typed is refused, not sent to Proposales", async () => {
    const id = await release_(clean({ startDate: f("2026-01-01", HAND_EVIDENCE) }));
    const { fake, deps } = setup();
    expect(await processEnquiry(id, deps)).toBe("needs_review");
    expect(fake.drafts).toHaveLength(0);
  });

  test("the hand marker does nothing without override: a model that writes it gets no trust", async () => {
    const id = await inReview(clean({ guests: f(500, HAND_EVIDENCE), startDate: f("2027-05-03", HAND_EVIDENCE), endDate: unknown }));
    await sql`UPDATE enquiries SET status = 'queued' WHERE id = ${id}`; // queued, but override is still false
    const { fake, deps } = setup();
    expect(await processEnquiry(id, deps)).toBe("needs_review");
    expect(fake.drafts).toHaveLength(0);
  });

  test("the same row twice: still exactly one draft", async () => {
    const id = await release_(clean({ guests: f(40, HAND_EVIDENCE), startDate: f("2027-03-10", HAND_EVIDENCE) }));
    const { fake, deps } = setup();
    expect(await processEnquiry(id, deps)).toBe("draft_created");
    expect(await processEnquiry(id, deps)).toBe("not_claimed");
    expect(fake.drafts).toHaveLength(1);
  });
});

// ---- POST /api/enquiries/[id]/create-anyway ---------------------------------------------------------------------

describe("POST /api/enquiries/[id]/create-anyway", () => {
  test("422 with reasons when the start date and guests are still missing; the row is not queued", async () => {
    const id = await inReview();
    const res = await release(id, 0);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.problems.join(" ")).toMatch(/Start date/);
    expect(body.problems.join(" ")).toMatch(/Guest count/);
    expect(await row(id)).toMatchObject({ status: "needs_review", override: false, version: 0 });
    expect(afterCallbacks).toHaveLength(0);
  });

  test("422 for a date in the past that was saved", async () => {
    const id = await inReview();
    await save(id, { startDate: "2020-01-01", guests: 40 }, 0);
    const res = await release(id, 1);
    expect(res.status).toBe(422);
    expect((await res.json()).problems.join(" ")).toMatch(/in the past/);
  });

  test("409 with the current data when the version is stale, and nothing is queued", async () => {
    const id = await inReview();
    await save(id, { startDate: "2027-05-03", guests: 40 }, 0); // version is now 1
    const res = await release(id, 0);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", current: { status: "needs_review", version: 1 } });
    expect(await row(id)).toMatchObject({ status: "needs_review", override: false });
  });

  test("409 when the row is not in review", async () => {
    const id = await inReview();
    await sql`UPDATE enquiries SET status = 'draft_created' WHERE id = ${id}`;
    expect((await release(id, 0)).status).toBe(409);
  });

  test("two presses at the same moment: one queues the row, the other gets a 409", async () => {
    const id = await inReview();
    await save(id, { startDate: "2027-05-03", guests: 40 }, 0);
    const results = await Promise.all([release(id, 1), release(id, 1), release(id, 1)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(afterCallbacks).toHaveLength(1); // one nudge
  });

  test("404 for an unknown id, 400 for a bad id or a bad version", async () => {
    expect((await release(MISSING, 0)).status).toBe(404);
    expect((await release("nope", 0)).status).toBe(400);
    expect((await call(createAnywayRoute, "POST", MISSING, { version: "0" })).status).toBe(400);
  });

  test("a masked address in the 409 payload", async () => {
    const real = "Call anna.berg@acme.com after 5";
    const id = await inReview(clean({ specialRequests: f(real, real) }));
    await save(id, { guests: 40 }, 0);
    const body = await (await release(id, 0)).json();
    expect(JSON.stringify(body)).not.toContain("anna.berg@acme.com");
  });
});
