import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { redact, scrub, shapeDiff } from "../scripts/probe-lib";
import { PLAN, runProbe } from "../scripts/probe";

const syntheticDir = join(__dirname, "..", "fixtures", "proposales", "synthetic");
const synthetic = (file: string) => JSON.parse(readFileSync(join(syntheticDir, file), "utf8"));
const API_KEY = "test-api-key-super-secret";
const INBOX_TOKEN = "secret-inbox-token-123";

// ---- a small stand-in for the Proposales API ---------------------------------------------------------------------

type Seen = { method: string; path: string; authorization?: string; body?: unknown };
type MockOptions = { catalog?: unknown[]; lagMs?: number; inboxToken?: string | null; inboxCreatesDraft?: boolean; createFailsWith?: number };

// The account owner, as a real server would reveal them in its answers.
const PERSON = { company: "Jane Doe Hotels", name: "Jane Doe", email: "jane.doe@doehotels.example" };

async function readBody(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : undefined;
}

function startMock(options: MockOptions = {}) {
  const seen: Seen[] = [];
  const drafts: Array<{ uuid: string; created: number; body: Record<string, unknown> }> = [];
  const catalog = options.catalog ?? synthetic("content.200.json").data;
  const lag = options.lagMs ?? 0;
  const searchable = (d: { created: number }) => Date.now() - d.created >= lag;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const body = await readBody(req);
    seen.push({ method: req.method ?? "", path: url.pathname, authorization: req.headers.authorization, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname.startsWith("/v1/inbox/")) {
      if (url.pathname.split("/").pop() !== INBOX_TOKEN) return send(404, synthetic("error.400.json"));
      if (options.inboxCreatesDraft) drafts.push({ uuid: crypto.randomUUID(), created: Date.now(), body: { recipient: { email: body.email } } });
      return send(200, { id: 77, echoed_token: url.pathname.split("/").pop() }); // a leaky server, to prove redaction works
    }
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return send(401, synthetic("error.401.json"));

    if (url.pathname === "/v3/companies") {
      const companies = synthetic("companies.200.json");
      companies.data[0].name = PERSON.company;
      companies.data[0].inbox_token = options.inboxToken === undefined ? INBOX_TOKEN : options.inboxToken;
      return send(200, companies);
    }
    if (url.pathname === "/v3/content") return send(200, { data: catalog });
    if (url.pathname === "/v3/proposals" && req.method === "POST") {
      if (options.createFailsWith && body?.company_id) return send(options.createFailsWith, synthetic("error.500.json"));
      if (!body?.company_id || !body?.language) return send(400, { ...synthetic("error.400.json"), debug: req.headers.authorization }); // leaks the key
      const uuid = crypto.randomUUID();
      drafts.push({ uuid, created: Date.now(), body });
      return send(200, { proposal: { uuid, url: `https://app.proposales.test/proposal/${uuid}` } });
    }
    const one = /^\/v3\/proposals\/([\w-]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const draft = drafts.find((d) => d.uuid === one[1]);
      if (!draft) return send(404, synthetic("error.400.json"));
      const blocks = ((draft.body.blocks as Array<Record<string, unknown>>) ?? []).map((b) => ({ ...b, title: `Block ${String(b.content_id)}` }));
      return send(200, { data: { uuid: draft.uuid, company_id: 1001, language: "en", attachments: [], blocks, data: draft.body.data ?? {}, company_name: PERSON.company, creator_name: PERSON.name, contact_email: PERSON.email, user_email: PERSON.email } });
    }
    if (url.pathname === "/v3/proposal-search") {
      const key = url.searchParams.get("filter[enquiry_key]");
      const email = url.searchParams.get("recipient_email");
      const hits = drafts.filter(searchable).filter((d) => {
        const data = d.body.data as Record<string, unknown> | undefined;
        const recipient = d.body.recipient as { email?: string } | undefined;
        return (key && data?.enquiry_key === key) || (email && recipient?.email === email);
      });
      return send(200, { data: hits.map((d) => ({ ...synthetic("search-by-data.200.json").data[0], uuid: d.uuid, data: d.body.data ?? {} })) });
    }
    send(404, synthetic("error.400.json"));
  });

  return new Promise<{ url: string; seen: Seen[]; drafts: typeof drafts; close: () => Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        seen,
        drafts,
        close: () => new Promise<void>((done) => server.close(() => done())),
      }),
    ),
  );
}

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

async function probe(options: MockOptions = {}, overrides: { apiKey?: string; pollMaxMs?: number } = {}) {
  const mock = await startMock(options);
  closers.push(mock.close);
  const outDir = mkdtempSync(join(tmpdir(), "probe-"));
  const result = await runProbe({
    baseUrl: mock.url,
    apiKey: overrides.apiKey ?? API_KEY,
    outDir,
    syntheticDir,
    pollIntervalMs: 5,
    pollMaxMs: overrides.pollMaxMs ?? 600,
    log: () => {},
  });
  const files = readdirSync(outDir);
  const read = (file: string) => readFileSync(join(outDir, file), "utf8");
  return { ...result, mock, outDir, files, read };
}

// ---- tests -------------------------------------------------------------------------------------------------------

describe("a full probe run", () => {
  test("saves every answer under the names of its synthetic twin, and writes the report", async () => {
    const run = await probe({ lagMs: 30 });
    expect(run.failed).toBe(false);
    for (const file of [
      "companies.200.json", "content.200.json", "create-minimal.200.json", "create-proposal.request.json", "create-proposal.200.json",
      "create-proposal-productids.200.json", "get-proposal.200.json", "search-by-data.200.json", "search-by-recipient.200.json",
      "create-proposal-duplicate.200.json", "error.400.json", "error.401.json", "create-rfp.200.json", "probe-report.md",
    ]) {
      expect(run.files, file).toContain(file);
    }
  });

  test("measures the search lag, and reports it", async () => {
    const run = await probe({ lagMs: 40 });
    expect(run.report).toMatch(/3\. Search by our data property: found after 0\.\d s/);
  });

  test("reports a draft that never becomes searchable instead of hanging", async () => {
    const run = await probe({ lagMs: 60_000 }, { pollMaxMs: 80 });
    expect(run.report).toContain("NOT found within");
  });

  test("tries both ids for content_id and reads the drafts back so a human can compare the block titles", async () => {
    const run = await probe();
    const creates = run.mock.seen.filter((r) => r.method === "POST" && r.path === "/v3/proposals");
    const blockIds = (body: unknown) => (body as { blocks?: Array<{ content_id: number }> }).blocks?.map((b) => b.content_id);
    expect(blockIds(creates[1].body)).toEqual([3001, 3002]); // variation ids
    expect(blockIds(creates[2].body)).toEqual([2001, 2002]); // product ids
    expect(run.report).toContain('Read back with variation ids as content_id: 2 block(s), titles: "Block 3001", "Block 3002"');
  });

  test("a second create with the same body is reported as a duplicate", async () => {
    const run = await probe();
    expect(run.report).toContain("YES, a second draft with a new uuid was created");
  });

  test("learns whether the inbox endpoint creates a draft on its own", async () => {
    expect(await probe({ inboxCreatesDraft: true }).then((r) => r.report)).toContain("a draft DID appear in search");
    expect(await probe({ inboxCreatesDraft: false }).then((r) => r.report)).toContain("no draft appeared in search");
  });

  test("lists the drafts it created so they can be opened in the UI and deleted", async () => {
    const run = await probe();
    expect(run.report).toContain("Drafts created (open each in the Proposales UI, then delete them)");
    expect(run.report).toContain("https://app.proposales.test/proposal/");
  });
});

describe("safety", () => {
  test("every draft is titled [PROBE] and the script only reads, creates drafts, or posts to the inbox", async () => {
    const run = await probe();
    const titles = run.mock.drafts.map((d) => d.body.title_md).filter(Boolean);
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) expect(title).toMatch(/^\[PROBE\]/);
    const allowed = new Set(["GET /v3/companies", "GET /v3/content", "POST /v3/proposals", "GET /v3/proposal-search", "POST /v1/inbox/" + INBOX_TOKEN]);
    for (const r of run.mock.seen) {
      const route = r.path.startsWith("/v3/proposals/") ? "GET /v3/proposals/{uuid}" : `${r.method} ${r.path}`;
      expect(["GET /v3/proposals/{uuid}", ...allowed], route).toContain(route);
    }
    expect(run.mock.seen.some((r) => ["PATCH", "PUT", "DELETE"].includes(r.method))).toBe(false);
  });

  test("the API key is sent as a bearer token, but never to the public inbox endpoint", async () => {
    const run = await probe();
    const inbox = run.mock.seen.find((r) => r.path.startsWith("/v1/inbox/"));
    expect(inbox?.authorization).toBeUndefined();
    expect(inbox?.body).toMatchObject({ is_test: "true" });
    expect(run.mock.seen.find((r) => r.path === "/v3/companies")?.authorization).toBe(`Bearer ${API_KEY}`);
  });

  test("neither the API key nor the inbox token appears in any saved file or in the report", async () => {
    const run = await probe();
    for (const file of run.files) {
      const text = run.read(file);
      expect(text, file).not.toContain(API_KEY);
      expect(text, file).not.toContain(INBOX_TOKEN);
    }
    expect(run.report).not.toContain(API_KEY);
    expect(JSON.parse(run.read("companies.200.json")).data[0].inbox_token).toBe("REDACTED");
  });
});

describe("when things are missing or wrong", () => {
  test("a rejected key stops the probe at the first request and says why", async () => {
    const run = await probe({}, { apiKey: "wrong-key" });
    expect(run.failed).toBe(true);
    expect(run.mock.seen).toHaveLength(1);
    expect(run.report).toContain("the API key was rejected");
  });

  test("an empty catalog skips the product drafts and tells you to seed products", async () => {
    const run = await probe({ catalog: [] });
    expect(run.report).toContain("No products in the catalog");
    expect(run.files).not.toContain("create-proposal-productids.200.json");
    const creates = run.mock.seen.filter((r) => r.method === "POST" && r.path === "/v3/proposals");
    expect(creates.every((r) => !(r.body as { blocks?: unknown[] }).blocks?.length)).toBe(true);
  });

  test("a company without an inbox token skips the inbox step", async () => {
    const run = await probe({ inboxToken: null });
    expect(run.report).toContain("skipped: the company has no inbox_token");
    expect(run.mock.seen.some((r) => r.path.startsWith("/v1/inbox/"))).toBe(false);
  });

  test("an unexpected failure is saved, listed in the report, and makes the run report failure", async () => {
    const run = await probe({ createFailsWith: 500 });
    expect(run.failed).toBe(true);
    expect(run.files).toContain("unexpected-create-minimal.500.json");
    expect(run.report).toContain("Unexpected responses");
    expect(run.report).toContain("create-minimal: HTTP 500");
    expect(run.report).toContain("- none"); // no drafts were created, and the report says so
  });
});

describe("personal data", () => {
  test("the owner's name, email and company name never reach a saved file, and the data is still there as placeholders", async () => {
    const run = await probe();
    for (const file of run.files) {
      for (const value of Object.values(PERSON)) expect(run.read(file), `${file} leaks ${value}`).not.toContain(value);
    }
    expect(JSON.parse(run.read("companies.200.json")).data[0].name).toBe("Example Hotel");
    const got = JSON.parse(run.read("get-proposal.200.json")).data;
    expect([got.company_name, got.creator_name, got.contact_email]).toEqual(["Example Hotel", "Example Owner", "owner@hotel.example.com"]);
  });
});

describe("helpers", () => {
  test("redact replaces every occurrence of every secret and ignores empty ones", () => {
    expect(redact("a SECRET b SECRET c TOKEN", ["SECRET", "TOKEN", null, undefined, ""])).toBe("a REDACTED b REDACTED c REDACTED");
  });

  test("scrub replaces personal data, longest value first, and ignores empty or short ones", () => {
    expect(scrub("Jane Doe Hotels / Jane Doe / jane@x.io", [["Jane Doe", "Owner"], ["Jane Doe Hotels", "Hotel"], ["jane@x.io", "o@h.example"], [null, "x"], ["ab", "y"]])).toBe("Hotel / Owner / o@h.example");
  });

  test("shapeDiff: same shape with different values agrees", () => {
    expect(shapeDiff({ data: [{ id: 1, name: "a" }] }, { data: [{ id: 99, name: "zzz" }] })).toEqual({ onlyReal: [], onlySynthetic: [] });
  });

  test("shapeDiff: extra, missing and retyped fields are all found", () => {
    const diff = shapeDiff({ id: "1", extra: true }, { id: 1, gone: null });
    expect(diff.onlyReal).toEqual(["$.extra:boolean", "$.id:string"]);
    expect(diff.onlySynthetic).toEqual(["$.gone:null", "$.id:number"]);
  });
});

describe("the command line", () => {
  test("--dry prints the plan and sends nothing, with no key needed", () => {
    const out = execFileSync("npx", ["tsx", "scripts/probe.ts", "--dry"], { cwd: join(__dirname, ".."), env: { ...process.env, PROPOSALES_API_KEY: "" }, encoding: "utf8" });
    expect(out).toContain("Dry run");
    for (const line of PLAN) expect(out).toContain(line);
  });

  test("without --dry and without a key it refuses to run", () => {
    expect(() =>
      execFileSync("npx", ["tsx", "scripts/probe.ts"], { cwd: join(__dirname, ".."), env: { ...process.env, PROPOSALES_API_KEY: "" }, encoding: "utf8", stdio: "pipe" }),
    ).toThrow(/PROPOSALES_API_KEY is not set/);
  });
});
