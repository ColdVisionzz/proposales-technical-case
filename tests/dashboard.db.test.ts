import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadDotEnv, requireEnv } from "../lib/db/env";
import { migrate } from "../lib/db/migrate";

let current: postgres.Sql;
vi.mock("../lib/db/client", () => ({ db: () => current }));
vi.mock("../lib/queue", () => ({ nudge: vi.fn(async () => {}) }));
// connection() only works inside a Next request; here it is a no-op.
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));

import { GET as getDetail, PATCH as patchEnquiry } from "../app/api/enquiries/[id]/route";
import { GET as getList } from "../app/api/enquiries/route";
import { insertEnquiry } from "../lib/db/enquiries";
import { recordEvent } from "../lib/db/events";
import { getEnquiryDetail, listEnquiries } from "../lib/db/enquiry-views";
import { writeChaos } from "../lib/db/settings";
import { clean, f } from "./extraction.fixtures";

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
});

afterAll(async () => {
  await sql.end();
});

const add = (n: number, body = "secret customer text") => insertEnquiry({ messageId: `m${n}`, source: "paste", subject: `Subject ${n}`, body, sender: "a@b.se" });

describe("listEnquiries", () => {
  test("newest first, carries the latest event step, never the email body", async () => {
    const first = await add(1);
    await sql`UPDATE enquiries SET created_at = now() - interval '1 minute' WHERE id = ${first.id}`;
    const second = await add(2);
    await recordEvent(second.id, "claimed", "try 1");
    await recordEvent(second.id, "extracted", "model-x");

    const rows = await listEnquiries();
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(rows[0].step).toBe("extracted");
    expect(rows[1].step).toBe("received");
    expect(JSON.stringify(rows)).not.toContain("secret customer text");
  });

  test("respects the limit", async () => {
    for (let i = 0; i < 3; i++) await add(i);
    expect(await listEnquiries(2)).toHaveLength(2);
  });
});

describe("getEnquiryDetail", () => {
  test("returns the body and the events in the order they happened", async () => {
    const { id } = await add(1);
    await recordEvent(id, "claimed", "try 1");
    await recordEvent(id, "done", "draft_created");
    const detail = await getEnquiryDetail(id);
    expect(detail?.body).toBe("secret customer text");
    expect(detail?.events.map((e) => e.step)).toEqual(["received", "claimed", "done"]);
    expect(detail?.step).toBe("done");
  });

  test("unknown id gives null", async () => {
    expect(await getEnquiryDetail("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("email addresses never leave the server", () => {
  const RAW = ["anna.berg@acme-hotels.com", "boss@acme-hotels.com", "carl@acme-hotels.com"];
  const leaks = (text: string) => RAW.filter((a) => text.includes(a) || text.includes(a.split("@")[0] + "@"));

  test("list, detail and the 409 body show masked addresses only", async () => {
    const { id } = await insertEnquiry({
      messageId: "mask1",
      source: "paste",
      subject: "From carl@acme-hotels.com",
      body: "Hello,\nplease cc boss@acme-hotels.com\nAnna",
      sender: "Anna Berg <anna.berg@acme-hotels.com>",
    });
    await sql`UPDATE enquiries SET extracted = ${sql.json(clean({ specialRequests: f("cc", "please cc boss@acme-hotels.com") }) as never)}, last_error = 'permanent: bad_request_400 (anna.berg@acme-hotels.com)' WHERE id = ${id}`;
    await recordEvent(id, "failed", "see carl@acme-hotels.com");

    const list = await (await getList()).text();
    const detail = await (await getDetail(new Request("http://x"), { params: Promise.resolve({ id }) })).text();
    const patch = await (
      await patchEnquiry(new Request("http://x", { method: "PATCH", body: JSON.stringify({ version: 99, extracted: clean() }) }), { params: Promise.resolve({ id }) })
    ).text();

    for (const text of [list, detail, patch]) expect(leaks(text)).toEqual([]);
    expect(list).toContain("Anna Berg <a***@a***.com>");
    expect(JSON.parse(detail).body).toContain("please cc b***@a***.com");
    expect(patch).toContain("b***@a***.com");
  });

  test("the pipeline still reads the real address from the database", async () => {
    const { id } = await insertEnquiry({ messageId: "mask2", source: "paste", subject: "s", body: "b", sender: "anna.berg@acme-hotels.com" });
    const [row] = await sql`SELECT sender FROM enquiries WHERE id = ${id}`;
    expect(row.sender).toBe("anna.berg@acme-hotels.com");
  });
});

describe("routes", () => {
  test("list route returns the rows and the chaos switch", async () => {
    await add(1);
    await writeChaos(true);
    const body = await (await getList()).json();
    expect(body.enquiries).toHaveLength(1);
    expect(body.chaos).toBe(true);
  });

  test("detail route: 400 for a bad id, 404 for a missing one, 200 for a real one", async () => {
    const call = (id: string) => getDetail(new Request("http://x"), { params: Promise.resolve({ id }) });
    expect((await call("nope")).status).toBe(400);
    expect((await call("00000000-0000-0000-0000-000000000000")).status).toBe(404);
    const { id } = await add(1);
    expect((await call(id)).status).toBe(200);
  });
});
