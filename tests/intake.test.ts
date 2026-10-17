import { createHmac } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadDotEnv, requireEnv } from "../lib/db/env";
import { migrate } from "../lib/db/migrate";

// Routes call db(); here it returns whatever `current` is, so a test can swap in a broken connection.
let current: postgres.Sql;
vi.mock("../lib/db/client", () => ({ db: () => current }));

import { POST as inbound } from "../app/api/inbound/route";
import { POST as paste } from "../app/api/enquiries/route";

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
  await sql`DROP TABLE IF EXISTS events, enquiries, schema_migrations CASCADE`;
  await migrate(url);
});

beforeEach(async () => {
  current = sql;
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
const pasteReq = (body: unknown) =>
  new Request("http://test/api/enquiries", { method: "POST", body: JSON.stringify(body) });

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

describe("paste intake", () => {
  test("a paste makes one row with the body", async () => {
    const res = await paste(pasteReq({ subject: "Wedding", body: "Hello, 40 guests" }));
    expect(res.status).toBe(201);
    const [row] = await sql`SELECT source, raw_body, raw_subject FROM enquiries`;
    expect(row).toEqual({ source: "paste", raw_body: "Hello, 40 guests", raw_subject: "Wedding" });
  });

  test("the same paste twice makes one row and points at the original", async () => {
    const first = await (await paste(pasteReq({ body: "Same text" }))).json();
    const res = await paste(pasteReq({ body: "Same text" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: first.id, created: false });
    expect(await count()).toBe(1);
  });

  test("an empty or invalid body returns 400", async () => {
    expect((await paste(pasteReq({ body: "   " }))).status).toBe(400);
    expect((await paste(pasteReq({}))).status).toBe(400);
    expect((await paste(new Request("http://test/api/enquiries", { method: "POST", body: "not json" }))).status).toBe(400);
    expect(await count()).toBe(0);
  });

  test("paste and email rows go through the same insert function", async () => {
    // Both routes import insertEnquiry; a row from each lands in the same table with the same dedupe key column.
    await inbound(webhook(received()));
    await paste(pasteReq({ body: "x" }));
    const rows = await sql`SELECT source FROM enquiries ORDER BY source`;
    expect(rows.map((r) => r.source)).toEqual(["email", "paste"]);
  });
});
