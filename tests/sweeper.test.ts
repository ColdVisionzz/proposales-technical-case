import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadDotEnv, requireEnv } from "../lib/db/env";
import { migrate } from "../lib/db/migrate";

// The code under test calls db(); here it returns the test branch connection.
let current: postgres.Sql;
vi.mock("../lib/db/client", () => ({ db: () => current }));
// The route's default nudge would call the network.
const nudged = vi.hoisted(() => vi.fn<(requestUrl: string, id: string) => Promise<void>>(async () => {}));
vi.mock("../lib/queue", () => ({ nudge: nudged }));

import { GET, POST } from "../app/api/sweeper/route";
import { insertEnquiry } from "../lib/db/enquiries";
import { processEnquiry, type Deps } from "../lib/pipeline/process";
import { MAX_TRIES } from "../lib/pipeline/retry";
import { SWEEP_BATCH, sweep } from "../lib/pipeline/sweeper";
import { createFakeGateway } from "../lib/proposales/fake";
import { catalog, clean, email, TODAY } from "./extraction.fixtures";

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
  await sql`TRUNCATE enquiries, events CASCADE`;
  nudged.mockClear();
});

afterAll(async () => {
  await sql?.end();
});

let counter = 0;
const add = async () => (await insertEnquiry({ messageId: `paste:${counter++}`, source: "paste", subject: email.subject, body: email.body, sender: "Anna <anna@northwind.example.com>" })).id;
const row = async (id: string) => (await sql`SELECT * FROM enquiries WHERE id = ${id}`)[0];

// The three stuck states, built by hand. "Old" means untouched for 2 minutes.
const stuckQueued = async () => {
  const id = await add();
  await sql`UPDATE enquiries SET updated_at = now() - interval '2 minutes' WHERE id = ${id}`;
  return id;
};
const stuckRetrying = async () => {
  const id = await add();
  await sql`UPDATE enquiries SET status = 'retrying', tries = 1, next_attempt_at = now() - interval '1 second' WHERE id = ${id}`;
  return id;
};
const stuckProcessing = async () => {
  const id = await add();
  await sql`UPDATE enquiries SET status = 'processing', tries = 1, locked_until = now() - interval '1 second' WHERE id = ${id}`;
  return id;
};

// A sweep with a recording nudge, returning the ids it woke.
async function run() {
  const woken: string[] = [];
  const result = await sweep("http://test", async (_url, id) => void woken.push(id));
  return { ...result, woken };
}

describe("sweep: the three stuck cases", () => {
  test("a queued row untouched for a minute, a due retrying row and an expired-lease row are each picked up", async () => {
    const queued = await stuckQueued();
    const retrying = await stuckRetrying();
    const processing = await stuckProcessing();
    const { woken, nudged: count, failed } = await run();
    expect(woken.sort()).toEqual([queued, retrying, processing].sort());
    expect(count).toBe(3);
    expect(failed).toBe(0);
  });

  test("healthy rows are left alone", async () => {
    await add(); // just queued: a nudge is on its way
    const waiting = await add();
    await sql`UPDATE enquiries SET status = 'retrying', tries = 1, next_attempt_at = now() + interval '10 minutes' WHERE id = ${waiting}`; // not due
    const working = await add();
    await sql`UPDATE enquiries SET status = 'processing', tries = 1, locked_until = now() + interval '1 minute' WHERE id = ${working}`; // live lease
    for (const status of ["draft_created", "needs_review", "failed_permanent", "ignored"]) {
      const id = await add();
      await sql`UPDATE enquiries SET status = ${status}, updated_at = now() - interval '1 day', next_attempt_at = now() - interval '1 day' WHERE id = ${id}`;
    }
    expect(await run()).toMatchObject({ woken: [], nudged: 0, failed: 0 });
  });
});

describe("sweep: the attempt cap", () => {
  test("an expired-lease row that is out of tries is failed with a reason, and not nudged", async () => {
    const id = await stuckProcessing();
    await sql`UPDATE enquiries SET tries = ${MAX_TRIES} WHERE id = ${id}`;
    expect(await run()).toMatchObject({ woken: [], nudged: 0, failed: 1 });
    expect(await row(id)).toMatchObject({
      status: "failed_permanent",
      last_error: `gave up after ${MAX_TRIES} tries: crashed repeatedly`,
      locked_until: null,
    });
    // and the timeline says so, since the dead worker could not
    expect(await sql`SELECT step, outcome FROM events WHERE enquiry_id = ${id} ORDER BY id`).toEqual([
      { step: "received", outcome: "paste" },
      { step: "failed", outcome: `gave up after ${MAX_TRIES} tries: crashed repeatedly` },
    ]);
  });

  test("a live-lease row at the cap is left alone: only an expired lease proves the worker is gone", async () => {
    const id = await add();
    await sql`UPDATE enquiries SET status = 'processing', tries = ${MAX_TRIES}, locked_until = now() + interval '1 minute' WHERE id = ${id}`;
    expect(await run()).toMatchObject({ failed: 0, nudged: 0 });
    expect((await row(id)).status).toBe("processing");
  });

  test("rows with no tries left never fill the batch, so they cannot starve rows that can still run", async () => {
    for (let n = 0; n < SWEEP_BATCH; n++) {
      const id = await stuckQueued();
      await sql`UPDATE enquiries SET tries = ${MAX_TRIES}, updated_at = now() - interval '1 day' WHERE id = ${id}`; // oldest, but unclaimable
    }
    const runnable = await stuckQueued();
    expect((await run()).woken).toEqual([runnable]);
  });
});

describe("sweep: batch and order", () => {
  test(`wakes at most ${SWEEP_BATCH} rows per run, the oldest first`, async () => {
    const ids: string[] = [];
    for (let n = 0; n < SWEEP_BATCH + 5; n++) {
      const id = await add();
      await sql`UPDATE enquiries SET updated_at = now() - make_interval(mins => ${100 - n}) WHERE id = ${id}`; // n = 0 is the oldest
      ids.push(id);
    }
    const { woken, nudged: count } = await run();
    expect(count).toBe(SWEEP_BATCH);
    expect(woken.sort()).toEqual(ids.slice(0, SWEEP_BATCH).sort());
  });
});

describe("sweep: running twice", () => {
  test("two sweeps at the same moment nudge the same row, and the claim still lets only one worker process it", async () => {
    const id = await stuckQueued();
    const fake = createFakeGateway(catalog);
    const extract = vi.fn(async () => ({ status: "ok" as const, extraction: clean(), meta: { model: "m", promptVersion: "v2", ms: 1, attempts: 1 } }));
    const deps: Deps = {
      fetchBody: async () => ({ text: email.body, html: null }),
      extract: extract as unknown as Deps["extract"],
      gateway: fake.gateway,
      companyId: 1001,
      today: () => TODAY,
      schedule: async () => {},
    };
    // The nudge here runs the real pipeline, as the worker route would.
    const send = async (_url: string, rowId: string) => void (await processEnquiry(rowId, deps));
    await Promise.all([sweep("http://test", send), sweep("http://test", send)]);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(fake.drafts).toHaveLength(1);
    expect((await row(id)).status).toBe("draft_created");
  });
});

// POST is the dashboard button: open to visitors, no secret.
describe("POST /api/sweeper", () => {
  test("works without any header, and the stuck row is nudged", async () => {
    delete process.env.CRON_SECRET;
    const id = await stuckQueued();
    const res = await POST(new Request("http://test/api/sweeper", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ failed: 0, nudged: 1 });
    expect(nudged).toHaveBeenCalledWith("http://test/api/sweeper", id);
  });
});

// GET is what Vercel's daily cron sends, and it stays behind the secret.
describe("GET /api/sweeper", () => {
  const call = (authorization?: string) =>
    GET(new Request("http://test/api/sweeper", { method: "GET", headers: authorization ? { authorization } : {} }));

  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
  });

  test("401 without the secret, with a wrong one, and when CRON_SECRET is unset; nothing is swept", async () => {
    const id = await stuckQueued();
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
    expect((await call("cron-secret")).status).toBe(401); // no "Bearer " prefix
    delete process.env.CRON_SECRET;
    expect((await call("Bearer undefined")).status).toBe(401);
    expect((await call("Bearer ")).status).toBe(401);
    expect(nudged).not.toHaveBeenCalled();
    expect((await row(id)).status).toBe("queued");
  });

  test("the worker secret does not open it", async () => {
    process.env.WORKER_SECRET = "worker-secret";
    expect((await call("Bearer worker-secret")).status).toBe(401);
  });

  test("200 with a summary, and the stuck row is nudged", async () => {
    const id = await stuckQueued();
    const res = await call("Bearer cron-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ failed: 0, nudged: 1 });
    expect(nudged).toHaveBeenCalledWith("http://test/api/sweeper", id);
  });
});
