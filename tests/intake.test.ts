import { createHmac } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadDotEnv, requireEnv } from "../lib/db/env";
import { migrate } from "../lib/db/migrate";

// Routes call db(); here it returns whatever `current` is, so a test can swap in a broken connection.
let current: postgres.Sql;
vi.mock("../lib/db/client", () => ({ db: () => current }));

// after() only works inside a real request. Here it collects the callbacks so a test can run them by hand.
const afterCallbacks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => void afterCallbacks.push(fn),
}));
const runAfter = () => Promise.all(afterCallbacks.splice(0).map((fn) => fn()));

import { POST as inbound } from "../app/api/inbound/route";

const SECRET_BYTES = Buffer.from("test-secret-for-intake-tests-123");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

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
  process.env.EMAIL_WEBHOOK_SECRET = SECRET;
  process.env.RESEND_API_KEY = "re_test";
  sql = postgres(url, { max: 1, onnotice: () => {} });
  current = sql;
  await sql`DROP TABLE IF EXISTS events, enquiries, settings, schema_migrations CASCADE`;
  await migrate(url);
});

const fetchMock = vi.fn();

beforeEach(async () => {
  current = sql;
  afterCallbacks.length = 0;
  fetchMock.mockReset().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  process.env.WORKER_SECRET = "worker-secret";
  await sql`TRUNCATE enquiries, events CASCADE`;
});

afterAll(async () => {
  await sql?.end();
});

// Signs the way Svix does: HMAC-SHA256 over "id.timestamp.payload".
function webhook(payload: object, { signed = true, id = "msg_1" } = {}) {
  const raw = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signed
    ? "v1," + createHmac("sha256", SECRET_BYTES).update(`${id}.${timestamp}.${raw}`).digest("base64")
    : "v1,AAAA";
  return new Request("http://test/api/inbound", {
    method: "POST",
    body: raw,
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature },
  });
}

const received = (messageId = "<abc@mail.example>") => ({
  type: "email.received",
  created_at: new Date().toISOString(),
  data: {
    email_id: "em_1",
    created_at: new Date().toISOString(),
    from: "Guest <guest@example.com>",
    to: ["inbox@example.resend.app"],
    bcc: [],
    cc: [],
    received_for: [],
    message_id: messageId,
    subject: "Room for 20",
    attachments: [],
  },
});

const count = async () => (await sql`SELECT count(*)::int AS n FROM enquiries`)[0].n as number;

describe("email intake", () => {
  test("a signed email makes one row with the webhook fields and no body yet", async () => {
    const res = await inbound(webhook(received()));
    expect(res.status).toBe(200);
    const [row] = await sql`SELECT * FROM enquiries`;
    expect(row).toMatchObject({
      source: "email",
      message_id: "<abc@mail.example>",
      email_id: "em_1",
      sender: "Guest <guest@example.com>",
      raw_subject: "Room for 20",
      raw_body: null,
      status: "queued",
    });
  });

  test("the same email delivered twice makes one row and points at the original", async () => {
    const first = await (await inbound(webhook(received()))).json();
    const second = await (await inbound(webhook(received(), { id: "msg_2" }))).json();
    expect(await count()).toBe(1);
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
  });

  test("two deliveries at the same moment still make one row", async () => {
    const results = await Promise.all([inbound(webhook(received())), inbound(webhook(received(), { id: "msg_2" }))]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await count()).toBe(1);
  });

  test("a bad signature returns 401 and stores nothing", async () => {
    const res = await inbound(webhook(received(), { signed: false }));
    expect(res.status).toBe(401);
    expect(await count()).toBe(0);
  });

  test("other event types return 200 and store nothing", async () => {
    const res = await inbound(webhook({ type: "email.delivered", created_at: "x", data: {} }));
    expect(res.status).toBe(200);
    expect(await count()).toBe(0);
  });

  test("a database failure returns 500 so the provider retries", async () => {
    current = postgres("postgres://nobody:nothing@127.0.0.1:1/none", { max: 1, connect_timeout: 2 });
    const res = await inbound(webhook(received()));
    expect(res.status).toBe(500);
    current = sql;
    expect(await count()).toBe(0);
  });
});

describe("worker nudge", () => {
  test("a new email nudges the worker once, with its id and the secret, only after the response", async () => {
    const { id } = await (await inbound(webhook(received()))).json();
    expect(fetchMock).not.toHaveBeenCalled(); // the response is already built, the nudge waits in after()
    await runAfter();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://test/api/worker");
    expect(init.headers.authorization).toBe("Bearer worker-secret");
    expect(JSON.parse(init.body)).toEqual({ id });
  });

  test("a duplicate delivery sends no second nudge", async () => {
    await inbound(webhook(received()));
    await inbound(webhook(received(), { id: "msg_2" }));
    await runAfter();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a failed insert sends no nudge", async () => {
    current = postgres("postgres://nobody:nothing@127.0.0.1:1/none", { max: 1, connect_timeout: 2 });
    await inbound(webhook(received()));
    await runAfter();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a worker that is down or refuses does not change the intake response or throw", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const res = await inbound(webhook(received()));
    await expect(runAfter()).resolves.toBeDefined();
    expect(res.status).toBe(200);
    expect(await count()).toBe(1); // the row is stored, the sweeper will find it

    fetchMock.mockResolvedValueOnce(new Response("no", { status: 401 }));
    await inbound(webhook(received("<refused@mail.example>"), { id: "msg_2" }));
    await expect(runAfter()).resolves.toBeDefined();
  });
});

describe("no public paste route", () => {
  test("/api/enquiries accepts no writes, so the only way in is the signed webhook", async () => {
    const route = await import("../app/api/enquiries/route");
    expect(Object.keys(route).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
  });
});
