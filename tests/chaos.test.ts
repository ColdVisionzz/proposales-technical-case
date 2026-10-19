import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadDotEnv, requireEnv } from "../lib/db/env";
import { migrate } from "../lib/db/migrate";

// The code under test calls db(); here it returns the test branch connection.
let current: postgres.Sql;
vi.mock("../lib/db/client", () => ({ db: () => current }));

// Lets a test make the chaos read fail, to prove an unreadable switch counts as off. Everything else is the real code.
const chaosRead = vi.hoisted(() => ({ fail: false }));
vi.mock("../lib/db/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/db/settings")>();
  return {
    ...real,
    readChaos: async () => {
      if (chaosRead.fail) throw new Error("database unreachable");
      return real.readChaos();
    },
  };
});

import { POST as chaosRoute } from "../app/api/chaos/route";
import { GET as healthRoute } from "../app/api/health/route";
import { readChaos, writeChaos } from "../lib/db/settings";
import { withChaos } from "../lib/pipeline/chaos";
import { checkHealth, DOWN_AFTER, stateOf } from "../lib/pipeline/health";
import { classifyHttp, GatewayError } from "../lib/proposales/errors";
import type { ProposalesGateway } from "../lib/proposales/gateway";

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
  sql = postgres(url, { max: 12, onnotice: () => {} });
  current = sql;
  await sql`DROP TABLE IF EXISTS events, enquiries, settings, schema_migrations CASCADE`;
  await migrate(url);
});

beforeEach(async () => {
  await sql`TRUNCATE settings`;
  chaosRead.fail = false;
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await sql?.end();
});

// A gateway that counts calls and can be told to fail.
function countingGateway() {
  const calls = { getCatalog: 0, findExistingDraft: 0, createDraft: 0 };
  let failure: GatewayError | undefined;
  const gateway: ProposalesGateway = {
    getCatalog: async () => {
      calls.getCatalog++;
      if (failure) throw failure;
      return [];
    },
    findExistingDraft: async () => {
      calls.findExistingDraft++;
      return null;
    },
    createDraft: async () => {
      calls.createDraft++;
      return { uuid: "u", url: "https://x" };
    },
  };
  return { gateway, calls, failWith: (f: GatewayError | undefined) => void (failure = f) };
}

// Pretend the last check was a while ago, so the next call is allowed to ping again.
const makeStale = () => sql`UPDATE settings SET value = jsonb_set(value, '{checkedAt}', to_jsonb(now() - interval '2 minutes')) WHERE key = 'proposales_health'`;

// ---- the chaos switch --------------------------------------------------------------------------------------------

describe("the chaos switch", () => {
  test("a missing row means off; it can be switched on and off, and the state is shared through the database", async () => {
    expect(await readChaos()).toBe(false);
    await writeChaos(true);
    expect(await readChaos()).toBe(true);
    await writeChaos(false);
    expect(await readChaos()).toBe(false);
    expect(await sql`SELECT key FROM settings WHERE key = 'chaos'`).toHaveLength(1); // one row, updated in place
  });

  test("on: every Proposales call fails with a retryable chaos failure, and nothing reaches Proposales", async () => {
    const { gateway, calls } = countingGateway();
    await writeChaos(true);
    const chaotic = withChaos(gateway);
    for (const call of [() => chaotic.getCatalog(), () => chaotic.findExistingDraft("k"), () => chaotic.createDraft({ company_id: 1, language: "en" })]) {
      const error = await call().catch((e) => e);
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).failure).toEqual({ kind: "retryable", reason: "chaos" });
    }
    expect(calls).toEqual({ getCatalog: 0, findExistingDraft: 0, createDraft: 0 });
  });

  test("off: every call passes straight through", async () => {
    const { gateway, calls } = countingGateway();
    const chaotic = withChaos(gateway);
    await chaotic.getCatalog();
    await chaotic.findExistingDraft("k");
    await chaotic.createDraft({ company_id: 1, language: "en" });
    expect(calls).toEqual({ getCatalog: 1, findExistingDraft: 1, createDraft: 1 });
  });

  test("it is read on every call, so flipping the switch takes effect at once on a wrapper that already exists", async () => {
    const { gateway } = countingGateway();
    const chaotic = withChaos(gateway);
    await expect(chaotic.getCatalog()).resolves.toEqual([]);
    await writeChaos(true);
    await expect(chaotic.getCatalog()).rejects.toBeInstanceOf(GatewayError);
    await writeChaos(false);
    await expect(chaotic.getCatalog()).resolves.toEqual([]);
  });

  test("an unreadable switch counts as OFF: a database blip must not fake an outage", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { gateway, calls } = countingGateway();
    await writeChaos(true); // it is ON in the database, but cannot be read right now
    chaosRead.fail = true;
    await expect(withChaos(gateway).getCatalog()).resolves.toEqual([]);
    expect(calls.getCatalog).toBe(1);
  });
});

describe("POST /api/chaos", () => {
  const call = (body: unknown, authorization?: string) =>
    chaosRoute(new Request("http://test/api/chaos", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: authorization ? { authorization } : {} }));

  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
  });

  test("401 without the secret, with a wrong one, and when CRON_SECRET is unset: the switch does not move", async () => {
    expect((await call({ on: true })).status).toBe(401);
    expect((await call({ on: true }, "Bearer nope")).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await call({ on: true }, "Bearer undefined")).status).toBe(401);
    expect(await readChaos()).toBe(false);
  });

  test("400 unless the body says on: true or false", async () => {
    for (const body of [{}, { on: "yes" }, { on: 1 }, "not json"]) expect((await call(body, "Bearer cron-secret")).status).toBe(400);
  });

  test("200 switches it on and off", async () => {
    const on = await call({ on: true }, "Bearer cron-secret");
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ on: true });
    expect(await readChaos()).toBe(true);
    await call({ on: false }, "Bearer cron-secret");
    expect(await readChaos()).toBe(false);
  });
});

// ---- health pings ------------------------------------------------------------------------------------------------

describe("stateOf", () => {
  const row = (failures: number, auth = false) => ({ failures, auth, checkedAt: null, lastOkAt: "2026-10-19T10:00:00Z", lastError: null });

  test("unknown before any check, ok below the threshold, down at it, auth at once", () => {
    expect(stateOf(null)).toBe("unknown");
    expect(stateOf({ failures: 0, auth: false, checkedAt: "2026-10-19T10:00:00Z", lastOkAt: null, lastError: null })).toBe("unknown"); // first ping still running
    expect(stateOf(row(0))).toBe("ok");
    expect(stateOf(row(DOWN_AFTER - 1))).toBe("ok"); // one failed ping is not an outage
    expect(stateOf(row(DOWN_AFTER))).toBe("down");
    expect(stateOf(row(1, true))).toBe("auth"); // a wrong key does not heal by itself: loud at the first failure
    expect(stateOf(row(0, true))).toBe("ok"); // a later success clears it
  });
});

describe("checkHealth", () => {
  test("the first call pings and reports ok", async () => {
    const { gateway, calls } = countingGateway();
    const health = await checkHealth(gateway);
    expect(calls.getCatalog).toBe(1);
    expect(health).toMatchObject({ state: "ok", lastError: null });
    expect(health.lastOkAt).not.toBeNull();
  });

  test("a fresh result is only read: asking again straight away does not ping", async () => {
    const { gateway, calls } = countingGateway();
    await checkHealth(gateway);
    await checkHealth(gateway);
    await checkHealth(gateway);
    expect(calls.getCatalog).toBe(1);
  });

  test("two failed pings in a row mean down; one success heals it", async () => {
    const { gateway, failWith } = countingGateway();
    await checkHealth(gateway); // ok
    failWith(new GatewayError({ kind: "retryable", reason: "upstream_503" }));
    await makeStale();
    expect((await checkHealth(gateway)).state).toBe("ok"); // one failure: still ok
    await makeStale();
    expect(await checkHealth(gateway)).toMatchObject({ state: "down", lastError: "upstream_503" });
    failWith(undefined);
    await makeStale();
    expect(await checkHealth(gateway)).toMatchObject({ state: "ok", lastError: null });
  });

  test("a wrong key (401) shows as auth at the first failure", async () => {
    const { gateway, failWith } = countingGateway();
    await checkHealth(gateway);
    failWith(new GatewayError(classifyHttp(401)));
    await makeStale();
    expect(await checkHealth(gateway)).toMatchObject({ state: "auth", lastError: "auth" });
  });

  test("twenty callers at the same moment cause exactly one ping", async () => {
    const { gateway, calls } = countingGateway();
    const results = await Promise.all(Array.from({ length: 20 }, () => checkHealth(gateway)));
    expect(calls.getCatalog).toBe(1);
    expect(results.every((r) => r.state === "ok")).toBe(true);
  });

  test("with the chaos switch on, health goes down after two pings, and heals when it is switched off", async () => {
    const { gateway } = countingGateway();
    const chaotic = withChaos(gateway);
    await writeChaos(true);
    await checkHealth(chaotic);
    await makeStale();
    expect(await checkHealth(chaotic)).toMatchObject({ state: "down", lastError: "chaos" });
    await writeChaos(false);
    await makeStale();
    expect((await checkHealth(chaotic)).state).toBe("ok");
  });
});

describe("GET /api/health", () => {
  test("answers with the state and is never cached", async () => {
    vi.stubEnv("PROPOSALES_API_KEY", ""); // the route builds its gateway from the environment: use the in-memory fake
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await healthRoute();
    vi.unstubAllEnvs();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ state: "ok" });
  });
});
