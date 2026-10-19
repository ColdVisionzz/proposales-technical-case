// The Proposales probe (task T3b). Asks the real API the questions we could only read about in the OpenAPI file,
// saves every answer under fixtures/proposales/real/, and writes probe-report.md with the answers and the places where
// the real API disagrees with our synthetic fixtures. The real answer always wins.
//
//   npm run probe -- --dry    print what it would do, send nothing (works without a key)
//   npm run probe             run it for real (needs PROPOSALES_API_KEY)
//
// It creates a few real DRAFT proposals titled "[PROBE]" in your account. Nothing is sent to anyone.
// Open them in the Proposales UI to look at them, then delete them.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv } from "../lib/db/env";
import { redact, scrub, shapeDiff } from "./probe-lib";

export type ProbeOptions = {
  baseUrl: string;
  apiKey: string;
  outDir: string;
  syntheticDir: string;
  companyId?: number;
  pollIntervalMs?: number; // how often to ask "is the draft searchable yet?"
  pollMaxMs?: number; // give up waiting after this long
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

type Reply = { status: number; ms: number; body: unknown };
const at = (value: unknown, ...keys: Array<string | number>): unknown =>
  keys.reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string | number, unknown>)[key] : undefined), value);
const ok = (reply: Reply) => reply.status >= 200 && reply.status < 300;
const list = (body: unknown): unknown[] => (Array.isArray(at(body, "data")) ? (at(body, "data") as unknown[]) : []);

export const PLAN = [
  "GET  /v3/companies                      find the company id and inbox token (proves the key works)",
  "GET  /v3/content                        read the product catalog",
  "POST /v3/proposals                      create a minimal draft",
  "POST /v3/proposals                      create a draft with two products (content_id = variation_id)",
  "POST /v3/proposals                      create the same with product_id instead, to learn which one content_id takes",
  "GET  /v3/proposals/{uuid}               read both drafts back, to see what the API kept",
  "GET  /v3/proposal-search                find the draft by data.enquiry_key, polling to measure the lag",
  "GET  /v3/proposal-search                find it by recipient email, polling to measure the lag",
  "POST /v3/proposals                      create the same draft again (does it make a second one?)",
  "POST /v3/proposals                      deliberately bad request ({}), to save the error shape",
  "GET  /v3/companies                      deliberately bad token, to save the 401 shape",
  "POST /v1/inbox/{token}                  public RFP intake with is_test, then check whether a draft appeared",
];

export async function runProbe(o: ProbeOptions): Promise<{ report: string; failed: boolean }> {
  const log = o.log ?? ((line: string) => console.log(line));
  const doFetch = o.fetchImpl ?? fetch;
  const pollInterval = o.pollIntervalMs ?? 1000;
  const pollMax = o.pollMaxMs ?? 60_000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const secrets: Array<string | null | undefined> = [o.apiKey];
  // Personal data of the account, learned from the answers as they arrive and replaced before anything is written.
  const personal: Array<[string | null | undefined, string]> = [];
  const clean = (text: string) => scrub(redact(text, secrets), personal);
  mkdirSync(o.outDir, { recursive: true });

  const saved: string[] = [];
  const save = (file: string, body: unknown) => {
    writeFileSync(join(o.outDir, file), clean(JSON.stringify(body, null, 2)) + "\n");
    saved.push(file);
  };

  async function call(method: string, path: string, opts: { query?: Record<string, string>; body?: unknown; token?: string | null } = {}): Promise<Reply> {
    const url = new URL(path, o.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? o.apiKey}`; // null = a public endpoint, no auth
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const started = Date.now();
    try {
      const res = await doFetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(20_000) });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep the text */
      }
      return { status: res.status, ms: Date.now() - started, body };
    } catch (error) {
      return { status: 0, ms: Date.now() - started, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  // Ask again and again until the answer satisfies `done`, or time runs out. Returns how long it took.
  async function poll(request: () => Promise<Reply>, done: (reply: Reply) => boolean, maxMs = pollMax) {
    const started = Date.now();
    let last = await request();
    while (!done(last) && Date.now() - started < maxMs) {
      await sleep(pollInterval);
      last = await request();
    }
    return { found: done(last), seconds: (Date.now() - started) / 1000, last };
  }

  const steps: string[] = [];
  const unexpected: string[] = [];
  const drafts: Array<{ label: string; uuid: string; url: string }> = [];
  const answers: string[] = [];
  const note = (name: string, reply: Reply, expected = "2xx") => {
    steps.push(`${name}: HTTP ${reply.status} in ${reply.ms} ms`);
    log(`  ${name}: HTTP ${reply.status} (${reply.ms} ms)`);
    if (expected === "2xx" && !ok(reply)) {
      unexpected.push(`${name}: HTTP ${reply.status}`);
      save(`unexpected-${name.replace(/\W+/g, "-")}.${reply.status}.json`, reply.body);
    }
  };

  // 1. Companies. If this fails nothing else can work, so say so and stop.
  log("Probing the Proposales API");
  const companies = await call("GET", "/v3/companies");
  note("companies", companies);
  if (!ok(companies)) {
    const why = companies.status === 401 || companies.status === 403 ? "the API key was rejected" : "the API could not be reached";
    const report = `# Proposales probe\n\nStopped at the first request: ${why} (HTTP ${companies.status}). Nothing else was tried.\n`;
    writeFileSync(join(o.outDir, "probe-report.md"), report);
    return { report, failed: true };
  }
  personal.push([at(list(companies.body)[0], "name") as string | undefined, "Example Hotel"]);
  save("companies.200.json", { ...(companies.body as object), data: list(companies.body).map((c) => ({ ...(c as object), inbox_token: at(c, "inbox_token") ? "REDACTED" : null })) });
  const company = (o.companyId ? list(companies.body).find((c) => at(c, "id") === o.companyId) : undefined) ?? list(companies.body)[0];
  const companyId = Number(at(company, "id"));
  const inboxToken = (at(company, "inbox_token") as string | null) ?? null;
  secrets.push(inboxToken);

  // 2. Catalog.
  const content = await call("GET", "/v3/content");
  note("content", content);
  if (ok(content)) save("content.200.json", content.body);
  const items = list(content.body).filter((c) => at(c, "deactivated_at") == null);
  const variationIds = items.slice(0, 2).map((c) => Number(at(c, "variation_id")));
  const productIds = items.slice(0, 2).map((c) => Number(at(c, "product_id")));

  // 3. Minimal draft: only the two fields the OpenAPI file marks as required.
  const minimalRequest = { company_id: companyId, language: "en" };
  const minimal = await call("POST", "/v3/proposals", { body: minimalRequest });
  note("create-minimal", minimal);
  save("create-minimal.request.json", minimalRequest);
  if (ok(minimal)) {
    save("create-minimal.200.json", minimal.body);
    drafts.push({ label: "minimal", uuid: String(at(minimal.body, "proposal", "uuid")), url: String(at(minimal.body, "proposal", "url")) });
  }

  // 4. Full drafts: recipient, our key in data, and two products. Once with variation ids, once with product ids.
  const fullRequest = (label: string, key: string, email: string, ids: number[]) => ({
    company_id: companyId,
    language: "en",
    title_md: `[PROBE] ${label}`,
    description_md: "Created by the probe script. Safe to delete. Never sent.",
    recipient: { first_name: "Probe", last_name: "Test", email, company_name: "Probe AB" },
    data: { enquiry_key: key, probe: "true" },
    blocks: ids.map((id, i) => ({ type: "product-block", content_id: id, quantity: i === 1 ? 12 : 1 })),
  });
  const keyA = crypto.randomUUID();
  const keyB = crypto.randomUUID();
  const reqA = fullRequest("with variation ids", keyA, "probe-a@example.com", variationIds);
  const reqB = fullRequest("with product ids", keyB, "probe-b@example.com", productIds);

  if (items.length === 0) answers.push("**No products in the catalog**, so the drafts with products were skipped. Seed 3 to 5 products in the Proposales UI (task T1b) and run the probe again.");
  const createA = await call("POST", "/v3/proposals", { body: reqA });
  note("create-with-variation-ids", createA);
  save("create-proposal.request.json", reqA);
  const uuidA = ok(createA) ? String(at(createA.body, "proposal", "uuid")) : "";
  if (ok(createA)) {
    save("create-proposal.200.json", createA.body);
    drafts.push({ label: "with variation ids", uuid: uuidA, url: String(at(createA.body, "proposal", "url")) });
  }
  const createB = items.length ? await call("POST", "/v3/proposals", { body: reqB }) : undefined;
  let uuidB = "";
  if (createB) {
    note("create-with-product-ids", createB);
    save("create-proposal-productids.request.json", reqB);
    if (ok(createB)) {
      uuidB = String(at(createB.body, "proposal", "uuid"));
      save("create-proposal-productids.200.json", createB.body);
      drafts.push({ label: "with product ids", uuid: uuidB, url: String(at(createB.body, "proposal", "url")) });
    }
  }

  // 5. Read them back: what did the API keep? Compare block titles by eye with the catalog.
  const describeBlocks = (body: unknown) => {
    const blocks = at(body, "data", "blocks");
    if (!Array.isArray(blocks)) return "no blocks returned";
    const titles = blocks.map((b) => `${JSON.stringify(at(b, "title") ?? null)}`).join(", ");
    return `${blocks.length} block(s), titles: ${titles}`;
  };
  const readBack: Record<string, string> = {};
  for (const [uuid, file, label] of [
    [uuidA, "get-proposal.200.json", "variation ids"],
    [uuidB, "get-proposal-productids.200.json", "product ids"],
  ] as const) {
    if (!uuid) continue;
    const got = await call("GET", `/v3/proposals/${uuid}`);
    note(`get-${label.replace(" ", "-")}`, got);
    if (ok(got)) {
      personal.push(
        [at(got.body, "data", "company_name") as string | undefined, "Example Hotel"],
        [at(got.body, "data", "creator_name") as string | undefined, "Example Owner"],
        [at(got.body, "data", "contact_email") as string | undefined, "owner@hotel.example.com"],
        [at(got.body, "data", "user_email") as string | undefined, "owner@hotel.example.com"],
      );
      save(file, got.body);
      readBack[label] = describeBlocks(got.body);
    }
  }

  // 6. Search by our own data property. The lag is the number that decides whether search-before-create is safe.
  let lagKey = "not measured";
  let searchByData: Reply | undefined;
  if (uuidA) {
    const result = await poll(
      () => call("GET", "/v3/proposal-search", { query: { [`filter[enquiry_key]`]: keyA, limit: "25" } }),
      (r) => ok(r) && list(r.body).some((d) => at(d, "uuid") === uuidA),
    );
    searchByData = result.last;
    note("search-by-data", result.last);
    save("search-by-data.200.json", result.last.body);
    lagKey = result.found ? `found after ${result.seconds.toFixed(1)} s` : `NOT found within ${(pollMax / 1000).toFixed(0)} s (last HTTP ${result.last.status})`;

    // 7. Search by recipient email (the fallback).
    const byEmail = await poll(
      () => call("GET", "/v3/proposal-search", { query: { recipient_email: "probe-a@example.com", limit: "25" } }),
      (r) => ok(r) && list(r.body).some((d) => at(d, "uuid") === uuidA),
    );
    note("search-by-recipient", byEmail.last);
    save("search-by-recipient.200.json", byEmail.last.body);
    answers.push(`Search by recipient email: ${byEmail.found ? `found after ${byEmail.seconds.toFixed(1)} s` : "NOT found within the wait"}.`);

    // 8. Create the same thing again. The API has no idempotency key, so a second draft is expected.
    const again = await call("POST", "/v3/proposals", { body: reqA });
    note("create-duplicate", again);
    let duplicate = "unknown";
    if (ok(again)) {
      const uuid2 = String(at(again.body, "proposal", "uuid"));
      save("create-proposal-duplicate.200.json", again.body);
      drafts.push({ label: "duplicate of the first", uuid: uuid2, url: String(at(again.body, "proposal", "url")) });
      const both = await poll(
        () => call("GET", "/v3/proposal-search", { query: { [`filter[enquiry_key]`]: keyA, limit: "25" } }),
        (r) => ok(r) && list(r.body).filter((d) => at(d, "uuid") === uuidA || at(d, "uuid") === uuid2).length >= 2,
        Math.min(pollMax, 30_000),
      );
      save("search-by-data-after-duplicate.200.json", both.last.body);
      duplicate = `${uuid2 !== uuidA ? "YES, a second draft with a new uuid was created" : "NO, the same uuid came back"}; search then returned ${list(both.last.body).length} draft(s) for the key`;
    }
    answers.push(`Creating the same draft twice: ${duplicate}.`);
  }

  // 9 and 10. Error shapes.
  const bad = await call("POST", "/v3/proposals", { body: {} });
  note("bad-request", bad, "any");
  save(`error.${bad.status}.json`, bad.body);
  const badKey = await call("GET", "/v3/companies", { token: "probe-invalid-token" });
  note("bad-key", badKey, "any");
  save(`error.${badKey.status}.json`, badKey.body);
  answers.push(`Error shapes saved: a bad request gave HTTP ${bad.status}, a bad key gave HTTP ${badKey.status}.`);

  // 11. The public inbox endpoint: does it create a draft by itself?
  let inbox = "skipped: the company has no inbox_token";
  if (inboxToken) {
    const rfp = await call("POST", `/v1/inbox/${encodeURIComponent(inboxToken)}`, {
      token: null,
      body: { email: "probe-rfp@example.com", first_name: "Probe", last_name: "Test", message: "Probe test, please ignore.", language: "en", is_test: "true" },
    });
    note("inbox", rfp);
    if (ok(rfp)) {
      save("create-rfp.200.json", rfp.body);
      const appeared = await poll(
        () => call("GET", "/v3/proposal-search", { query: { recipient_email: "probe-rfp@example.com", limit: "25" } }),
        (r) => ok(r) && list(r.body).length > 0,
        Math.min(pollMax, 15_000),
      );
      save("search-by-rfp-recipient.200.json", appeared.last.body);
      inbox = `HTTP ${rfp.status}, request id ${String(at(rfp.body, "id"))}; ${appeared.found ? "a draft DID appear in search" : "no draft appeared in search"} for that recipient within ${Math.min(pollMax, 15_000) / 1000} s`;
    } else inbox = `HTTP ${rfp.status}`;
  }

  // Where does the real API disagree with the synthetic fixtures? The real answer wins.
  const disagreements: string[] = [];
  for (const file of ["companies.200.json", "content.200.json", "create-proposal.200.json", "search-by-data.200.json", "search-by-recipient.200.json", "error.400.json", "error.401.json"]) {
    const real = join(o.outDir, file);
    const twin = join(o.syntheticDir, file);
    if (!saved.includes(file) || !existsSync(real) || !existsSync(twin)) continue;
    const diff = shapeDiff(JSON.parse(readFileSync(real, "utf8")), JSON.parse(readFileSync(twin, "utf8")));
    if (diff.onlyReal.length || diff.onlySynthetic.length) {
      disagreements.push(`### ${file}`, ...diff.onlyReal.slice(0, 40).map((p) => `- only in real: \`${p}\``), ...diff.onlySynthetic.slice(0, 40).map((p) => `- only in synthetic: \`${p}\``), "");
    }
  }

  const report = [
    "# Proposales probe report",
    "",
    `Run: ${new Date().toISOString()} against ${o.baseUrl}`,
    "",
    "## Drafts created (open each in the Proposales UI, then delete them)",
    ...(drafts.length ? drafts.map((d) => `- ${d.label}: ${d.url}`) : ["- none"]),
    "",
    "## The six probe answers (copy into NOTES.md)",
    `1. Can a minimal draft be created? ${ok(minimal) ? `Yes (HTTP ${minimal.status})` : `No (HTTP ${minimal.status})`}. Request: create-minimal.request.json.`,
    `2. Fields for a draft with products, a recipient and dates: see create-proposal.request.json (${createA ? (ok(createA) ? "accepted" : `rejected, HTTP ${createA.status}`) : "skipped"}) and create-proposal-productids.request.json (${createB ? (ok(createB) ? "accepted" : `rejected, HTTP ${createB.status}`) : "skipped"}).`,
    `   Read back with variation ids as content_id: ${readBack["variation ids"] ?? "n/a"}`,
    `   Read back with product ids as content_id: ${readBack["product ids"] ?? "n/a"}`,
    `   Compare those titles with content.200.json: the one that matches the products you asked for is the id content_id takes.`,
    `3. Search by our data property: ${lagKey}${searchByData ? ` (last HTTP ${searchByData.status})` : ""}. ${answers.find((a) => a.startsWith("Search by recipient")) ?? ""}`,
    `4. ${answers.find((a) => a.startsWith("Creating the same")) ?? "Creating the same draft twice: not tested."}`,
    `5. ${answers.find((a) => a.startsWith("Error shapes")) ?? "Error shapes: not tested."}`,
    `6. POST /v1/inbox/{token}: ${inbox}.`,
    "",
    ...(answers.filter((a) => a.startsWith("**")).length ? ["## Notes", ...answers.filter((a) => a.startsWith("**")), ""] : []),
    "## Steps",
    ...steps.map((s) => `- ${s}`),
    "",
    ...(unexpected.length ? ["## Unexpected responses (saved as unexpected-*.json)", ...unexpected.map((u) => `- ${u}`), ""] : []),
    "## Where the real API disagrees with the synthetic fixtures",
    ...(disagreements.length ? disagreements : ["No shape differences found in the compared files.", ""]),
    "## Saved files",
    ...saved.map((f) => `- ${f}`),
    "",
  ].join("\n");
  writeFileSync(join(o.outDir, "probe-report.md"), clean(report));
  return { report, failed: unexpected.length > 0 };
}

async function main() {
  loadDotEnv();
  if (process.argv.includes("--dry")) {
    console.log("Dry run: nothing is sent. The probe would, in order:\n");
    PLAN.forEach((line, i) => console.log(`${String(i + 1).padStart(2)}. ${line}`));
    console.log("\nIt saves answers under fixtures/proposales/real/ and writes probe-report.md there.");
    return;
  }
  const apiKey = process.env.PROPOSALES_API_KEY;
  if (!apiKey) {
    console.error("PROPOSALES_API_KEY is not set. Put it in .env (never commit it), or try: npm run probe -- --dry");
    process.exit(1);
  }
  const root = join(__dirname, "..", "fixtures", "proposales");
  const { report, failed } = await runProbe({
    baseUrl: process.env.PROPOSALES_BASE_URL ?? "https://api.proposales.com",
    apiKey,
    outDir: join(root, "real"),
    syntheticDir: join(root, "synthetic"),
    companyId: process.env.PROPOSALES_COMPANY_ID ? Number(process.env.PROPOSALES_COMPANY_ID) : undefined,
  });
  console.log(`\n${report}`);
  if (failed) process.exit(1);
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
