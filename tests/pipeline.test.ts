import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadDotEnv, requireEnv } from "../lib/db/env";
import { migrate } from "../lib/db/migrate";

// The pipeline calls db(); here it returns the test branch connection.
let current: postgres.Sql;
vi.mock("../lib/db/client", () => ({ db: () => current }));

import { claimEnquiry, finishDraft, insertEnquiry, LostLeaseError, registerFingerprint, saveBody } from "../lib/db/enquiries";
import { MAX_EMAIL_CHARS } from "../lib/email/text";
import { classifyHttp, GatewayError } from "../lib/proposales/errors";
import { createFakeGateway } from "../lib/proposales/fake";
import { fingerprintOf } from "../lib/pipeline/fingerprint";
import { processEnquiry, type Deps } from "../lib/pipeline/process";
import { writeChaos } from "../lib/db/settings";
import { withChaos } from "../lib/pipeline/chaos";
import { productionDeps } from "../lib/pipeline/deps";
import { SimulatedCrash } from "../lib/pipeline/faults";
import { BACKOFF_SECONDS, LEASE_SECONDS, MAX_MODEL_TRIES, MAX_TRIES, WATCHDOG_SECONDS } from "../lib/pipeline/retry";
import { wake } from "../lib/pipeline/wake";
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
  await sql`TRUNCATE enquiries, events CASCADE`;
});

afterAll(async () => {
  await sql?.end();
});

// ---- helpers ----------------------------------------------------------------------------------------------------

const SENDER = "Anna Lindqvist <anna@northwind.example.com>";
let counter = 0;
const addPaste = async (body = email.body, sender: string | null = SENDER) =>
  (await insertEnquiry({ messageId: `paste:${counter++}`, source: "paste", subject: email.subject, body, sender: sender ?? undefined })).id;
const addEmail = async () =>
  (await insertEnquiry({ messageId: `<m${counter++}@example>`, source: "email", emailId: "em_1", subject: email.subject, sender: SENDER })).id;
const row = async (id: string) => (await sql`SELECT * FROM enquiries WHERE id = ${id}`)[0];
const makeDue = (id: string) => sql`UPDATE enquiries SET next_attempt_at = now() - interval '1 second' WHERE id = ${id}`;

const okExtract = (extraction = clean()) =>
  vi.fn(async () => ({ status: "ok" as const, extraction, meta: { model: "test/model", promptVersion: "v2", ms: 1, attempts: 1 } }));

// Fresh fakes per test. `fake` is the in-memory Proposales, `extractFn` and `fetchBody` count how often they are used.
function setup(overrides: Partial<Deps> = {}, extraction = clean()) {
  const fake = createFakeGateway(catalog);
  const extractFn = okExtract(extraction);
  const fetchBody = vi.fn(async () => ({ text: email.body, html: null as string | null }));
  const schedule = vi.fn<Deps["schedule"]>(async () => {}); // records the delayed wake-ups a parked row asks for
  const deps: Deps = {
    fetchBody,
    extract: extractFn as unknown as Deps["extract"],
    gateway: fake.gateway,
    companyId: 1001,
    today: () => TODAY,
    schedule,
    ...overrides,
  };
  return { fake, extractFn, fetchBody, schedule, deps };
}

// ---- outcomes ---------------------------------------------------------------------------------------------------

describe("outcomes", () => {
  test("a clean paste becomes one draft with dates, guests and product blocks, and the row records it", async () => {
    const id = await addPaste();
    const { fake, deps, fetchBody } = setup();
    expect(await processEnquiry(id, deps)).toBe("draft_created");

    expect(fake.drafts).toHaveLength(1);
    const [draft] = fake.drafts;
    expect(draft.input).toMatchObject({
      company_id: 1001,
      data: { enquiry_key: id },
      recipient: { email: "anna@northwind.example.com" },
      blocks: [
        { content_id: 3001, quantity: 2 }, // 12-13 March: 2 event days
        { content_id: 3002, quantity: 48 }, // 24 guests x 2 days
      ],
    });
    expect(draft.input.description_md).toContain("2027-03-12 to 2027-03-13");
    expect(await row(id)).toMatchObject({
      status: "draft_created",
      proposal_uuid: draft.uuid,
      proposal_url: draft.url,
      attempts: 1,
      locked_until: null,
      last_error: null,
      model: "test/model",
      prompt_version: "v2",
    });
    expect((await row(id)).extracted.guests.value).toBe(24);
    expect(fetchBody).not.toHaveBeenCalled(); // paste rows already have their body
  });

  test("an email row fetches its body once and saves it", async () => {
    const id = await addEmail();
    const { deps, fetchBody } = setup();
    expect(await processEnquiry(id, deps)).toBe("draft_created");
    expect(fetchBody).toHaveBeenCalledExactlyOnceWith("em_1");
    expect((await row(id)).raw_body).toBe(email.body);
  });

  test("an HTML-only email is turned into text and read", async () => {
    const id = await addEmail();
    const { deps, fake } = setup({ fetchBody: vi.fn(async () => ({ text: null, html: `<html><body><p>${email.body}</p></body></html>` })) });
    expect(await processEnquiry(id, deps)).toBe("draft_created");
    expect((await row(id)).raw_body).toBe(email.body);
    expect(fake.drafts).toHaveLength(1);
  });

  test("an email with no readable text goes to review without calling the model", async () => {
    const id = await addEmail();
    const { deps, extractFn, fake } = setup({ fetchBody: vi.fn(async () => ({ text: null, html: null })) });
    expect(await processEnquiry(id, deps)).toBe("needs_review");
    expect(extractFn).not.toHaveBeenCalled();
    expect(fake.drafts).toHaveLength(0);
    expect((await row(id)).flags.reasons).toEqual(["The email has no readable text"]);
  });

  test("a vague enquiry ends in needs_review with the reasons saved and no draft", async () => {
    const id = await addPaste();
    const { deps, fake } = setup({}, clean({ startDate: f(null, null), endDate: f(null, null), guests: f(null, null) }));
    expect(await processEnquiry(id, deps)).toBe("needs_review");
    expect(fake.drafts).toHaveLength(0);
    const saved = await row(id);
    expect(saved).toMatchObject({ status: "needs_review", proposal_uuid: null, locked_until: null });
    expect(saved.flags.reasons).toEqual(["Start date: not found in the email", "Guest count: not found in the email"]);
  });

  test("a non-enquiry ends in ignored with no draft", async () => {
    const id = await addPaste();
    const { deps, fake } = setup({}, clean({ isEnquiry: false }));
    expect(await processEnquiry(id, deps)).toBe("ignored");
    expect(fake.drafts).toHaveLength(0);
    expect((await row(id)).status).toBe("ignored");
  });

  test("invalid model output ends in needs_review, nothing is saved as an extraction, and nothing crashes", async () => {
    const id = await addPaste();
    const extractFn = vi.fn(async () => ({ status: "invalid" as const, reason: "No object generated", meta: { model: "m", promptVersion: "v2", ms: 1, attempts: 2 } }));
    const { deps, fake } = setup({ extract: extractFn as unknown as Deps["extract"] });
    expect(await processEnquiry(id, deps)).toBe("needs_review");
    expect(fake.drafts).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: "needs_review", extracted: null });
  });

  test("a very long email is cut for the model, flagged on the draft, and kept whole in the database", async () => {
    const long = email.body + "\n" + "filler words ".repeat(3000);
    const id = await addPaste(long);
    const { deps, extractFn } = setup();
    expect(await processEnquiry(id, deps)).toBe("draft_created");
    const sent = (extractFn.mock.calls[0] as unknown as [{ body: string }])[0].body;
    expect(sent).toHaveLength(MAX_EMAIL_CHARS);
    const saved = await row(id);
    expect(saved.raw_body).toBe(long);
    expect(saved.flags.flags).toContainEqual(expect.objectContaining({ field: "email", level: "check" }));
  });

  test("a garbled saved extraction is not trusted: the model runs again", async () => {
    const id = await addPaste();
    await sql`UPDATE enquiries SET extracted = ${sql.json({ nonsense: true })} WHERE id = ${id}`;
    const { deps, extractFn } = setup();
    expect(await processEnquiry(id, deps)).toBe("draft_created");
    expect(extractFn).toHaveBeenCalledTimes(1);
  });
});

// ---- Guarantee 1: one enquiry, one draft -------------------------------------------------------------------------

describe("one enquiry never creates two drafts", () => {
  test("crash after the draft is created but before it is saved: the retry finds it and creates nothing", async () => {
    const id = await addPaste();
    const { fake, deps, extractFn } = setup();
    fake.crashAfterNextCreate(); // the draft exists at "Proposales", the caller never learns its uuid

    expect(await processEnquiry(id, deps)).toBe("retrying");
    expect(fake.drafts).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "retrying", proposal_uuid: null });

    await makeDue(id);
    expect(await processEnquiry(id, deps)).toBe("draft_created");
    expect(fake.drafts).toHaveLength(1); // still one
    expect((await row(id)).proposal_uuid).toBe(fake.drafts[0].uuid);
    expect(extractFn).toHaveBeenCalledTimes(1); // and the model was not paid for twice
  });

  test("a draft with this enquiry's key already at Proposales is reused, not duplicated", async () => {
    const id = await addPaste();
    const { fake, deps } = setup();
    const existing = await fake.gateway.createDraft({ company_id: 1001, language: "en", data: { enquiry_key: id } });
    expect(await processEnquiry(id, deps)).toBe("draft_created");
    expect(fake.drafts).toHaveLength(1);
    expect((await row(id)).proposal_uuid).toBe(existing.uuid);
  });

  test("the search runs before the create, and extraction is saved before either", async () => {
    const id = await addPaste();
    const { fake, deps } = setup();
    fake.failNext("findExistingDraft", { kind: "retryable", reason: "upstream_503" });
    expect(await processEnquiry(id, deps)).toBe("retrying");
    expect(fake.drafts).toHaveLength(0); // the failed search stopped the create
    expect((await row(id)).extracted).not.toBeNull(); // saved before any Proposales draft call
  });

  test("a retry resumes: it does not fetch the body or call the model again", async () => {
    const id = await addEmail();
    const { fake, deps, extractFn, fetchBody } = setup();
    fake.failNext("createDraft", { kind: "retryable", reason: "upstream_503" });
    expect(await processEnquiry(id, deps)).toBe("retrying");
    await makeDue(id);
    expect(await processEnquiry(id, deps)).toBe("draft_created");
    expect(fetchBody).toHaveBeenCalledTimes(1);
    expect(extractFn).toHaveBeenCalledTimes(1);
    expect(fake.drafts).toHaveLength(1);
  });
});

// ---- Guarantee 2: the claim --------------------------------------------------------------------------------------

describe("the same text sent again never creates a second draft", () => {
  // Each send has its own Message-ID, so these are separate rows: only the content can show they are repeats.
  const addCopy = async (sender = SENDER) => {
    const { id } = await insertEnquiry({ messageId: `<copy${counter++}@example>`, source: "email", emailId: "em_x", subject: email.subject, sender });
    return { id };
  };
  const run = async (id: string, deps: Deps) => processEnquiry(id, deps);

  test("three sends of the same email: one draft, and the repeats cost no model call", async () => {
    const { fake, deps, extractFn } = setup();
    const ids = [await addCopy(), await addCopy(), await addCopy()].map((c) => c.id);
    expect(await run(ids[0], deps)).toBe("draft_created");
    expect(await run(ids[1], deps)).toBe("draft_created");
    expect(await run(ids[2], deps)).toBe("draft_created");
    expect(fake.drafts).toHaveLength(1);
    expect(extractFn).toHaveBeenCalledTimes(1);
    const rows = await Promise.all(ids.map(row));
    expect(new Set(rows.map((r) => r.proposal_uuid)).size).toBe(1); // all three point at the same draft
    expect(rows.map((r) => r.duplicate_of)).toEqual([null, ids[0], ids[0]]);
    expect(rows[1].flags.reasons[0]).toMatch(/Same email as an earlier enquiry/);
  });

  test("spacing and case do not matter, the sender's name does not matter, the address does", async () => {
    const { fake, deps } = setup();
    const a = await addCopy("Anna <anna@northwind.example.com>");
    const b = await addCopy("ANNA@Northwind.example.com");
    await run(a.id, deps);
    await run(b.id, { ...deps, fetchBody: vi.fn(async () => ({ text: email.body.toUpperCase().replace(/ /g, "   "), html: null })) });
    expect(fake.drafts).toHaveLength(1);
  });

  test("a changed body is a new enquiry, and so is another sender", async () => {
    const { fake, deps } = setup();
    const a = await addCopy();
    const b = await addCopy();
    const c = await addCopy("Bo <bo@other.example.com>");
    await run(a.id, deps);
    // One added sentence: the quotes the model gave are still in the text, but it is no longer the same email.
    await run(b.id, { ...deps, fetchBody: vi.fn(async () => ({ text: `${email.body}\n\nP.S. We also need a flipchart.`, html: null })) });
    await run(c.id, deps);
    expect(fake.drafts).toHaveLength(3);
    expect((await row(b.id)).duplicate_of).toBeNull();
  });

  test("a repeat after the window is a new enquiry", async () => {
    const { fake, deps } = setup();
    const a = await addCopy();
    await run(a.id, deps);
    await sql`UPDATE enquiries SET created_at = now() - interval '8 days' WHERE id = ${a.id}`;
    const b = await addCopy();
    await run(b.id, deps);
    expect(fake.drafts).toHaveLength(2);
  });

  test("a row with no sender address is not fingerprinted", async () => {
    const { fake, deps } = setup();
    const a = await addPaste(email.body, null);
    const b = await addPaste(email.body, null);
    await run(a, deps);
    await run(b, deps);
    expect(fake.drafts).toHaveLength(2);
    expect((await row(a)).fingerprint).toBeNull();
  });

  test("the first copy ended without a draft (needs review): the repeat is not stuck waiting, it is judged on its own", async () => {
    const vague = clean({ startDate: f(null, null), endDate: f(null, null), guests: f(null, null) });
    const { fake, deps, extractFn } = setup({}, vague);
    const a = await addCopy();
    const b = await addCopy();
    expect(await run(a.id, deps)).toBe("needs_review");
    expect(await run(b.id, deps)).toBe("needs_review");
    expect(extractFn).toHaveBeenCalledTimes(2);
    expect(fake.drafts).toHaveLength(0);
  });

  test("a copy that arrives while the first is still being processed waits, then reuses its draft", async () => {
    const { fake, deps, extractFn } = setup();
    const a = await addCopy();
    const b = await addCopy();
    // The first copy has won the right to create but has not finished (its worker is mid-way).
    const claimed = await claimEnquiry(a.id, MAX_TRIES);
    await sql`UPDATE enquiries SET raw_body = ${email.body} WHERE id = ${a.id}`;
    await registerFingerprint(a.id, claimed!.attempt, fingerprintOf(SENDER, email.body)!, 7);

    expect(await run(b.id, deps)).toBe("retrying");
    expect(await row(b.id)).toMatchObject({ status: "retrying", last_error: "retryable: duplicate_in_flight" });
    expect(extractFn).not.toHaveBeenCalled(); // waiting costs nothing

    await sql`UPDATE enquiries SET locked_until = now() - interval '1 second' WHERE id = ${a.id}`; // the first worker's lease runs out
    expect(await run(a.id, deps)).toBe("draft_created"); // its retry skips the fingerprint step: it owns the creation
    await makeDue(b.id);
    expect(await run(b.id, deps)).toBe("draft_created");
    expect(fake.drafts).toHaveLength(1);
    expect((await row(b.id)).duplicate_of).toBe(a.id);
  });

  // The race this layer exists for. Without the advisory lock, copies that look at the same moment all see "nobody
  // owns this" and all proceed.
  test("five copies processed at the same moment: exactly one draft", async () => {
    const { fake, deps } = setup();
    const ids = (await Promise.all(Array.from({ length: 5 }, () => addCopy()))).map((c) => c.id);
    await Promise.all(ids.map((id) => run(id, deps)));
    for (let round = 0; round < 3; round++) {
      await sql`UPDATE enquiries SET next_attempt_at = now() - interval '1 second' WHERE status = 'retrying'`;
      await Promise.all(ids.map((id) => run(id, deps)));
    }
    expect(fake.drafts).toHaveLength(1);
    expect((await Promise.all(ids.map(row))).map((r) => r.status)).toEqual(Array(5).fill("draft_created"));
    expect(await sql`SELECT 1 FROM enquiries WHERE dedupe_cleared`).toHaveLength(1);
  });

  // Found by a concurrency test: the check used two separate statements ("is there a finished draft?", then "is anyone still working?").
  // A copy that finished between them was counted as neither, and the next copy created a second draft. The window is a
  // few milliseconds wide, so one run rarely hits it: this repeats the race. Fixed by asking both questions in one statement.
  test("five copies at once, repeated: never a second draft, even when a copy finishes mid-check", async () => {
    for (let n = 0; n < 15; n++) {
      await sql`TRUNCATE enquiries, events CASCADE`;
      const { fake, deps } = setup();
      const ids = (await Promise.all(Array.from({ length: 5 }, () => addCopy()))).map((c) => c.id);
      await Promise.all(ids.map((id) => run(id, deps)));
      for (let round = 0; round < 3; round++) {
        await sql`UPDATE enquiries SET next_attempt_at = now() - interval '1 second' WHERE status = 'retrying'`;
        await Promise.all(ids.map((id) => run(id, deps)));
      }
      expect(fake.drafts, `round ${n}`).toHaveLength(1);
    }
  }, 120_000);

  test("a worker that lost its lease cannot register a fingerprint", async () => {
    const a = await addCopy();
    const claimed = await claimEnquiry(a.id, MAX_TRIES);
    await expect(registerFingerprint(a.id, claimed!.attempt + 1, "x".repeat(64), 7)).rejects.toBeInstanceOf(LostLeaseError);
    expect((await row(a.id)).fingerprint).toBeNull(); // nothing was saved
  });
});

describe("the claim", () => {
  test("five workers at the same moment: exactly one processes the row", async () => {
    const id = await addPaste();
    const fake = createFakeGateway(catalog);
    const slow = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { status: "ok" as const, extraction: clean(), meta: { model: "m", promptVersion: "v2", ms: 1, attempts: 1 } };
    });
    const { deps } = setup({ gateway: fake.gateway, extract: slow as unknown as Deps["extract"] });
    const results = await Promise.all(Array.from({ length: 5 }, () => processEnquiry(id, deps)));
    expect(results.filter((r) => r === "draft_created")).toHaveLength(1);
    expect(results.filter((r) => r === "not_claimed")).toHaveLength(4);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fake.drafts).toHaveLength(1);
    expect((await row(id)).attempts).toBe(1);
  });

  test("an expired lease can be taken over, a live one cannot", async () => {
    const id = await addPaste();
    expect(await claimEnquiry(id, MAX_TRIES)).toMatchObject({ attempt: 1 });
    expect(await claimEnquiry(id, MAX_TRIES)).toBeNull(); // lease still running
    await sql`UPDATE enquiries SET locked_until = now() - interval '1 second' WHERE id = ${id}`;
    expect(await claimEnquiry(id, MAX_TRIES)).toMatchObject({ attempt: 2 }); // worker crashed, lease ran out
  });

  test("a retrying row is claimable only once its time has come", async () => {
    const id = await addPaste();
    await sql`UPDATE enquiries SET status = 'retrying', next_attempt_at = now() + interval '1 minute' WHERE id = ${id}`;
    expect(await claimEnquiry(id, MAX_TRIES)).toBeNull();
    await makeDue(id);
    expect(await claimEnquiry(id, MAX_TRIES)).not.toBeNull();
  });

  test.each(["draft_created", "needs_review", "failed_permanent", "ignored"])("a %s row is never claimed again", async (status) => {
    const id = await addPaste();
    await sql`UPDATE enquiries SET status = ${status} WHERE id = ${id}`;
    expect(await claimEnquiry(id, MAX_TRIES)).toBeNull();
  });

  test("an unknown id claims nothing", async () => {
    expect(await claimEnquiry("0b9f4c2e-6d1a-4f4e-9a52-3c1d2e7a8b90", MAX_TRIES)).toBeNull();
  });
});

// ---- the fencing check -------------------------------------------------------------------------------------------

describe("a worker that lost its lease cannot write", () => {
  test("a stale attempt number is refused by every write, a current one is accepted", async () => {
    const id = await addPaste();
    await claimEnquiry(id, MAX_TRIES); // attempt 1
    await sql`UPDATE enquiries SET locked_until = now() - interval '1 second' WHERE id = ${id}`;
    await claimEnquiry(id, MAX_TRIES); // attempt 2 takes over
    await expect(saveBody(id, 1, "stale")).rejects.toBeInstanceOf(LostLeaseError);
    await expect(finishDraft(id, 1, { uuid: "0b9f4c2e-6d1a-4f4e-9a52-3c1d2e7a8b90", url: "https://x" }, { flags: [], reasons: [] })).rejects.toBeInstanceOf(LostLeaseError);
    expect(await row(id)).toMatchObject({ status: "processing", proposal_uuid: null });
    await finishDraft(id, 2, { uuid: "0b9f4c2e-6d1a-4f4e-9a52-3c1d2e7a8b90", url: "https://x" }, { flags: [], reasons: [] });
    expect((await row(id)).status).toBe("draft_created");
  });

  test("a slow worker whose lease ran out stops quietly and leaves the newer worker's row alone", async () => {
    const id = await addPaste();
    const { deps } = setup();
    // While worker A is inside the model call its lease runs out and worker B claims the row.
    const takeover = vi.fn(async () => {
      await sql`UPDATE enquiries SET locked_until = now() - interval '1 second' WHERE id = ${id}`;
      expect(await claimEnquiry(id, MAX_TRIES)).toMatchObject({ attempt: 2 });
      return { status: "ok" as const, extraction: clean(), meta: { model: "A", promptVersion: "v2", ms: 1, attempts: 1 } };
    });
    const result = await processEnquiry(id, { ...deps, extract: takeover as unknown as Deps["extract"] });
    expect(result).toBe("lost_lease");
    expect(await row(id)).toMatchObject({ status: "processing", extracted: null, model: null }); // B's row, untouched by A
  });
});

// ---- failures ----------------------------------------------------------------------------------------------------

describe("failures", () => {
  test("a model outage (503) is retryable: the row is parked with a due time, and is not claimable early", async () => {
    const id = await addPaste();
    const down = vi.fn(async () => {
      throw Object.assign(new Error("service unavailable"), { statusCode: 503 });
    });
    const { deps, fake } = setup({ extract: down as unknown as Deps["extract"] });
    expect(await processEnquiry(id, deps)).toBe("retrying");
    expect(await row(id)).toMatchObject({ status: "retrying", last_error: "retryable: upstream_503", locked_until: null });
    const [{ secs }] = await sql`SELECT extract(epoch FROM next_attempt_at - now())::float AS secs FROM enquiries WHERE id = ${id}`;
    // first try failed: the first backoff step, plus or minus 10% jitter (and a little time spent since)
    expect(secs).toBeGreaterThan(BACKOFF_SECONDS[0] * 0.9 - 5);
    expect(secs).toBeLessThanOrEqual(BACKOFF_SECONDS[0] * 1.1);
    expect(await processEnquiry(id, deps)).toBe("not_claimed");
    expect(fake.drafts).toHaveLength(0);
  });

  test("a 400 from Proposales is permanent: the row stays, with the error, and is never claimed again", async () => {
    const id = await addPaste();
    const { fake, deps } = setup();
    fake.failNext("createDraft", classifyHttp(400));
    expect(await processEnquiry(id, deps)).toBe("failed_permanent");
    const saved = await row(id);
    expect(saved).toMatchObject({ status: "failed_permanent", last_error: "permanent: bad_request_400", locked_until: null });
    expect(saved.raw_body).toBe(email.body); // the original email is still there for a human
    expect(saved.extracted).not.toBeNull();
    expect(await processEnquiry(id, deps)).toBe("not_claimed");
  });

  test("a wrong Proposales key (401) is permanent", async () => {
    const id = await addPaste();
    const { fake, deps } = setup();
    fake.failNext("getCatalog", classifyHttp(401));
    expect(await processEnquiry(id, deps)).toBe("failed_permanent");
    expect((await row(id)).last_error).toBe("permanent: auth");
  });

  test("a failed body fetch is classified like any other: 503 retries, 404 stops", async () => {
    const down = setup({ fetchBody: vi.fn(async () => { throw new GatewayError(classifyHttp(503)); }) });
    expect(await processEnquiry(await addEmail(), down.deps)).toBe("retrying");
    const gone = setup({ fetchBody: vi.fn(async () => { throw new GatewayError(classifyHttp(404)); }) });
    const id = await addEmail();
    expect(await processEnquiry(id, gone.deps)).toBe("failed_permanent");
    expect((await row(id)).last_error).toBe("permanent: bad_request_404");
  });

  test("an unrecognised error is permanent and never reported as success", async () => {
    const id = await addPaste();
    const boom = vi.fn(async () => {
      throw new Error("something in our own code broke");
    });
    const { deps, fake } = setup({ extract: boom as unknown as Deps["extract"] });
    expect(await processEnquiry(id, deps)).toBe("failed_permanent");
    expect((await row(id)).last_error).toBe("permanent: unknown");
    expect(fake.drafts).toHaveLength(0);
  });

  test("the saved error never contains the email's words", async () => {
    const id = await addPaste();
    const leaky = vi.fn(async () => {
      throw Object.assign(new Error(`failed on: ${email.body}`), { statusCode: 500 });
    });
    const { deps } = setup({ extract: leaky as unknown as Deps["extract"] });
    await processEnquiry(id, deps);
    expect((await row(id)).last_error).not.toContain("meeting room");
  });
});

// ---- backoff, Retry-After and the attempt cap, one test per failure-matrix row --------------------------------------

describe("retries and the cap", () => {
  // Pretend the row has already been tried n - 1 times, so the next claim is try number n.
  const asTryNumber = (id: string, n: number) => sql`UPDATE enquiries SET tries = ${n - 1} WHERE id = ${id}`;
  const secondsUntilDue = async (id: string) =>
    (await sql`SELECT extract(epoch FROM next_attempt_at - now())::float AS secs FROM enquiries WHERE id = ${id}`)[0].secs as number;
  const modelDown = (status: number) =>
    vi.fn(async () => {
      throw Object.assign(new Error("model down"), { statusCode: status });
    }) as unknown as Deps["extract"];

  test.each([
    [1, BACKOFF_SECONDS[0]],
    [2, BACKOFF_SECONDS[1]],
    [3, BACKOFF_SECONDS[2]],
    [4, BACKOFF_SECONDS[3]],
  ])("Proposales 503 on try %i parks the row for about %i s (plus or minus 10%%)", async (n, base) => {
    const id = await addPaste();
    const { fake, deps } = setup();
    await asTryNumber(id, n);
    fake.failNext("createDraft", classifyHttp(503));
    expect(await processEnquiry(id, deps)).toBe("retrying");
    const secs = await secondsUntilDue(id);
    expect(secs).toBeGreaterThan(base * 0.9 - 5);
    expect(secs).toBeLessThanOrEqual(base * 1.1);
  });

  test("Proposales 503 on the last try gives up with the reason", async () => {
    const id = await addPaste();
    const { fake, deps } = setup();
    await asTryNumber(id, MAX_TRIES);
    fake.failNext("createDraft", classifyHttp(503));
    expect(await processEnquiry(id, deps)).toBe("failed_permanent");
    expect((await row(id)).last_error).toBe(`gave up after ${MAX_TRIES} tries: retryable: upstream_503`);
  });

  test("a model error gives up sooner than a Proposales error: try 2 retries, try 3 stops", async () => {
    const early = await addPaste();
    await asTryNumber(early, MAX_MODEL_TRIES - 1);
    expect(await processEnquiry(early, setup({ extract: modelDown(503) }).deps)).toBe("retrying");
    const last = await addPaste(email.body, "Bo <bo@other.example.com>"); // another sender, so it does not wait for the row above
    await asTryNumber(last, MAX_MODEL_TRIES);
    expect(await processEnquiry(last, setup({ extract: modelDown(503) }).deps)).toBe("failed_permanent");
    expect((await row(last)).last_error).toBe(`gave up after ${MAX_MODEL_TRIES} tries: retryable: upstream_503`);
  });

  test("a 429 with Retry-After waits at least as long as the server asked", async () => {
    const id = await addPaste();
    const { fake, deps } = setup();
    fake.failNext("createDraft", classifyHttp(429, "300"));
    expect(await processEnquiry(id, deps)).toBe("retrying");
    expect(await secondsUntilDue(id)).toBeGreaterThan(295); // the 30 s backoff alone would be far shorter
  });

  test.each([400, 401, 403, 404, 422])("a %i is never retried, even on the first try", async (status) => {
    const id = await addPaste();
    const { fake, deps } = setup();
    fake.failNext("createDraft", classifyHttp(status));
    expect(await processEnquiry(id, deps)).toBe("failed_permanent");
    expect((await row(id)).next_attempt_at).toBeNull();
  });

  test("a database blip mid-pipeline is retryable, not a permanent unknown", async () => {
    const id = await addPaste();
    const blip = vi.fn(async () => {
      throw Object.assign(new Error("connection closed"), { code: "CONNECTION_CLOSED" });
    });
    expect(await processEnquiry(id, setup({ extract: blip as unknown as Deps["extract"] }).deps)).toBe("retrying");
    expect((await row(id)).last_error).toBe("retryable: database");
  });

  test("a row with no tries left is not claimed, however it got there (crashes count, not only caught errors)", async () => {
    const id = await addPaste();
    await asTryNumber(id, MAX_TRIES + 1); // five claims already happened, all without a caught failure
    expect(await processEnquiry(id, setup().deps)).toBe("not_claimed");
  });
});

// ---- a parked row asks for a delayed wake-up ------------------------------------------------------------------

describe("the delayed wake-up", () => {
  const dueIn = async (id: string) =>
    (await sql`SELECT extract(epoch FROM next_attempt_at - now())::float AS secs FROM enquiries WHERE id = ${id}`)[0].secs as number;

  test("a retryable failure parks the row first, then schedules a wake-up for the same delay the row waits", async () => {
    const id = await addPaste();
    const { fake, deps, schedule } = setup();
    fake.failNext("createDraft", classifyHttp(503));
    expect(await processEnquiry(id, deps)).toBe("retrying");
    expect(schedule).toHaveBeenCalledTimes(2); // call 1 is the watchdog sent at the claim, call 2 is the retry
    const [scheduledId, delay] = schedule.mock.calls[1];
    expect(scheduledId).toBe(id);
    expect(delay).toBeGreaterThanOrEqual(BACKOFF_SECONDS[0] * 0.9);
    expect(delay).toBeLessThanOrEqual(BACKOFF_SECONDS[0] * 1.1);
    expect(Math.abs((await dueIn(id)) - delay)).toBeLessThan(5); // the row is due when the message arrives
  });

  test("a 429's Retry-After carries into the scheduled delay", async () => {
    const id = await addPaste();
    const { fake, deps, schedule } = setup();
    fake.failNext("createDraft", classifyHttp(429, "300"));
    await processEnquiry(id, deps);
    expect(schedule.mock.calls[1][1]).toBeGreaterThanOrEqual(300);
  });

  test("the row is already parked as retrying when the retry wake-up is requested", async () => {
    const id = await addPaste();
    const statuses: string[] = [];
    const { fake, deps } = setup({ schedule: async () => void statuses.push((await row(id)).status) });
    fake.failNext("createDraft", classifyHttp(503));
    await processEnquiry(id, deps);
    expect(statuses).toEqual(["processing", "retrying"]); // watchdog right after the claim, then park first and send: a lost message never loses the row
  });

  test.each([400, 401, 403, 422])("a permanent %i schedules no retry (only the watchdog from the claim)", async (status) => {
    const id = await addPaste();
    const { fake, deps, schedule } = setup();
    fake.failNext("createDraft", classifyHttp(status));
    expect(await processEnquiry(id, deps)).toBe("failed_permanent");
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test("giving up at the cap schedules no retry", async () => {
    const id = await addPaste();
    const { fake, deps, schedule } = setup();
    await sql`UPDATE enquiries SET tries = ${MAX_TRIES - 1} WHERE id = ${id}`;
    fake.failNext("createDraft", classifyHttp(503));
    expect(await processEnquiry(id, deps)).toBe("failed_permanent");
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test("a success schedules no retry", async () => {
    const { deps, schedule } = setup();
    expect(await processEnquiry(await addPaste(), deps)).toBe("draft_created");
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test("a worker that lost its lease does not schedule a retry for a row it no longer owns", async () => {
    const id = await addPaste();
    const { deps, schedule } = setup({
      extract: vi.fn(async () => {
        await sql`UPDATE enquiries SET locked_until = now() - interval '1 second' WHERE id = ${id}`;
        await claimEnquiry(id, MAX_TRIES); // worker B takes over
        throw Object.assign(new Error("model down"), { statusCode: 503 });
      }) as unknown as Deps["extract"],
    });
    expect(await processEnquiry(id, deps)).toBe("lost_lease");
    expect(schedule).toHaveBeenCalledTimes(1); // only the watchdog from its own claim
  });
});

// ---- the process dies after Proposales created the draft and before our row learns about it -------------------------
// The one window where the outside world and our database disagree. A test cannot kill a process, so a hook throws
// SimulatedCrash and processEnquiry lets it through its catch: nothing after it runs and nothing is saved, as in a real crash.

describe("crash after create", () => {
  const dies = { afterCreate: () => { throw new SimulatedCrash("after create"); } };
  const expireLease = (id: string) => sql`UPDATE enquiries SET locked_until = now() - interval '1 second' WHERE id = ${id}`;

  test("the world is split after the crash, and the retry reunites it with exactly one draft and no second model call", async () => {
    const id = await addPaste();
    const { fake, deps, extractFn } = setup({ faults: dies });
    await expect(processEnquiry(id, deps)).rejects.toBeInstanceOf(SimulatedCrash);

    // The crash really happened between create and save: Proposales has the draft, our row knows nothing.
    expect(fake.drafts).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "processing", proposal_uuid: null, proposal_url: null, last_error: null, tries: 1 });
    expect((await row(id)).extracted).not.toBeNull(); // the model was already paid for, and saved

    await expireLease(id); // the dead worker's lease runs out
    expect(await processEnquiry(id, { ...deps, faults: undefined })).toBe("draft_created");
    expect(fake.drafts).toHaveLength(1); // still one: search-before-create found it
    expect(await row(id)).toMatchObject({ status: "draft_created", proposal_uuid: fake.drafts[0].uuid, attempts: 2, tries: 2 });
    expect(extractFn).toHaveBeenCalledTimes(1);
  });

  test("five workers race to recover the crashed row: exactly one draft", async () => {
    const id = await addPaste();
    const { fake, deps } = setup({ faults: dies });
    await expect(processEnquiry(id, deps)).rejects.toBeInstanceOf(SimulatedCrash);
    await expireLease(id);
    const results = await Promise.all(Array.from({ length: 5 }, () => processEnquiry(id, { ...deps, faults: undefined })));
    expect(results.filter((r) => r === "draft_created")).toHaveLength(1);
    expect(fake.drafts).toHaveLength(1);
  });

  test("the same enquiry processed twice makes one draft: the second run is refused", async () => {
    const id = await addPaste();
    const { fake, deps } = setup();
    expect(await processEnquiry(id, deps)).toBe("draft_created");
    expect(await processEnquiry(id, deps)).toBe("not_claimed");
    expect(fake.drafts).toHaveLength(1);
  });

  test("search lag right after the crash: the key search misses but the sender-email fallback still finds the draft", async () => {
    const id = await addPaste();
    const { fake, deps } = setup({ faults: dies });
    await expect(processEnquiry(id, deps)).rejects.toBeInstanceOf(SimulatedCrash);
    fake.missNextKeySearch(); // the index has not caught up with the new draft's key
    await expireLease(id);
    expect(await processEnquiry(id, { ...deps, faults: undefined })).toBe("draft_created");
    expect(fake.drafts).toHaveLength(1);
  });

  // KNOWN LIMIT (SPEC, Guarantee 1): this documents the gap, it does not endorse it. With no sender address and a key
  // search that misses, the retry cannot find the draft and creates a second one. Probe: the key was findable after
  // 0.2 s, and retries wait at least 30 s, so it needs a lagging index and a sender-less enquiry at once.
  // If the gap is ever closed, this test is meant to fail: change it to expect 1.
  test("known limit: no sender and a lagging key search lets the retry create a second draft", async () => {
    const id = await addPaste(email.body, null);
    const { fake, deps } = setup({ faults: dies });
    await expect(processEnquiry(id, deps)).rejects.toBeInstanceOf(SimulatedCrash);
    fake.missNextKeySearch();
    await expireLease(id);
    expect(await processEnquiry(id, { ...deps, faults: undefined })).toBe("draft_created");
    expect(fake.drafts).toHaveLength(2);
  });

  test("the crash hook is off in production: productionDeps() never sets it", () => {
    vi.stubEnv("PROPOSALES_API_KEY", ""); // fake gateway, no real credentials needed
    try {
      expect(productionDeps().faults).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---- the watchdog. A crash runs no code, so a dead worker cannot ask for its own retry ---------------------------

describe("the watchdog", () => {
  const dies = { afterCreate: () => { throw new SimulatedCrash("after create"); } };
  const expireLease = (id: string) => sql`UPDATE enquiries SET locked_until = now() - interval '1 second' WHERE id = ${id}`;

  test("every successful claim sends a watchdog for just after the lease, before any work", async () => {
    const id = await addPaste();
    const { deps, schedule } = setup();
    await processEnquiry(id, deps);
    expect(schedule.mock.calls[0]).toEqual([id, WATCHDOG_SECONDS]);
    expect(WATCHDOG_SECONDS).toBeGreaterThan(LEASE_SECONDS);
  });

  test("a refused claim sends nothing", async () => {
    const id = await addPaste();
    const { deps, schedule } = setup();
    await sql`UPDATE enquiries SET status = 'draft_created' WHERE id = ${id}`;
    expect(await processEnquiry(id, deps)).toBe("not_claimed");
    expect(schedule).not.toHaveBeenCalled();
  });

  test("LEASE_SECONDS equals the lease the claim really takes, so the watchdog cannot drift from it", async () => {
    const id = await addPaste();
    await claimEnquiry(id, MAX_TRIES);
    const [{ secs }] = await sql`SELECT extract(epoch FROM locked_until - now())::float AS secs FROM enquiries WHERE id = ${id}`;
    expect(secs).toBeGreaterThan(LEASE_SECONDS - 5);
    expect(secs).toBeLessThanOrEqual(LEASE_SECONDS);
  });

  test("a crashed worker is recovered by its own watchdog message, with no sweeper involved", async () => {
    const id = await addPaste();
    const { fake, deps, schedule } = setup({ faults: dies });
    await expect(processEnquiry(id, deps)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(schedule).toHaveBeenCalledTimes(1); // the only thing the dead worker managed to do: ask to be woken
    await expireLease(id); // time passes until the watchdog is due
    await wake({ id }, (rowId) => processEnquiry(rowId, { ...deps, faults: undefined })); // the queue delivers the message
    expect(await row(id)).toMatchObject({ status: "draft_created", proposal_uuid: fake.drafts[0].uuid });
    expect(fake.drafts).toHaveLength(1);
  });

  test("a watchdog that arrives after the worker finished changes nothing", async () => {
    const id = await addPaste();
    const { deps } = setup();
    await processEnquiry(id, deps);
    const before = await row(id);
    await wake({ id }, (rowId) => processEnquiry(rowId, deps));
    expect(await row(id)).toEqual(before);
  });

  test("a watchdog that arrives while the worker still holds a live lease is refused", async () => {
    const id = await addPaste();
    await claimEnquiry(id, MAX_TRIES); // worker busy, lease running
    const { deps } = setup();
    expect(await processEnquiry(id, deps)).toBe("not_claimed");
    expect((await row(id)).attempts).toBe(1);
  });
});

// ---- the chaos demo, and the timeline of events --------------------------------------------------------------------

describe("the chaos demo", () => {
  test("switch on: the row parks as retrying and asks for a wake-up; switch off: the wake-up produces the draft by itself", async () => {
    const id = await addPaste();
    const { fake, deps, schedule, extractFn } = setup();
    const chaotic = { ...deps, gateway: withChaos(fake.gateway) };

    await writeChaos(true);
    expect(await processEnquiry(id, chaotic)).toBe("retrying");
    expect(await row(id)).toMatchObject({ status: "retrying", last_error: "retryable: chaos" });
    expect((await row(id)).next_attempt_at).toBeInstanceOf(Date); // with a time to wake up
    expect(fake.drafts).toHaveLength(0);
    expect(schedule).toHaveBeenCalledTimes(2); // the watchdog at the claim, then the retry wake-up

    await writeChaos(false);
    await makeDue(id); // the delayed message arrives
    await wake({ id }, (rowId) => processEnquiry(rowId, chaotic));
    expect((await row(id)).status).toBe("draft_created");
    expect(fake.drafts).toHaveLength(1);
    expect(extractFn).toHaveBeenCalledTimes(1); // recovery did not pay for the model again
  });
});

describe("production wiring", () => {
  test("productionDeps() puts the chaos switch in front of Proposales: the live demo depends on it", async () => {
    vi.stubEnv("PROPOSALES_API_KEY", ""); // fake gateway
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeChaos(true);
      await expect(productionDeps().gateway.getCatalog()).rejects.toMatchObject({ failure: { kind: "retryable", reason: "chaos" } });
    } finally {
      await writeChaos(false);
      vi.unstubAllEnvs();
    }
  });

  test("a rejected request keeps the start of the response in the row and the timeline", async () => {
    const id = await addPaste();
    const { fake, deps } = setup();
    fake.failNext("createDraft", { kind: "permanent", reason: "bad_request_400", detail: "currency: invalid" });
    await processEnquiry(id, deps);
    expect((await row(id)).last_error).toBe("permanent: bad_request_400 (currency: invalid)");
    expect((await sql`SELECT outcome FROM events WHERE enquiry_id = ${id} AND step = 'failed'`)[0].outcome).toBe("permanent: bad_request_400 (currency: invalid)");
  });
});

describe("the timeline (events)", () => {
  const steps = async (id: string) => (await sql`SELECT step FROM events WHERE enquiry_id = ${id} ORDER BY id`).map((r) => r.step as string);
  const events = async (id: string) => await sql`SELECT step, outcome FROM events WHERE enquiry_id = ${id} ORDER BY id`;

  test("a clean paste leaves the whole story in order", async () => {
    const id = await addPaste();
    await processEnquiry(id, setup().deps);
    expect(await steps(id)).toEqual(["received", "claimed", "extracted", "decided", "draft_created", "done"]);
  });

  test("an email also shows when its body was fetched", async () => {
    const id = await addEmail();
    await processEnquiry(id, setup().deps);
    expect(await steps(id)).toEqual(["received", "claimed", "body_fetched", "extracted", "decided", "draft_created", "done"]);
  });

  test("a failure and its recovery both show: the error and the retry, then a second try without a second extraction", async () => {
    const id = await addPaste();
    const { fake, deps } = setup();
    fake.failNext("createDraft", classifyHttp(503));
    await processEnquiry(id, deps);
    expect((await events(id)).at(-1)).toMatchObject({ step: "retry_scheduled", outcome: expect.stringMatching(/^retryable: upstream_503, in \d+s$/) });
    await makeDue(id);
    await processEnquiry(id, deps);
    expect(await steps(id)).toEqual(["received", "claimed", "extracted", "decided", "retry_scheduled", "claimed", "decided", "draft_created", "done"]);
    expect((await events(id)).filter((e) => e.step === "claimed").map((e) => e.outcome)).toEqual(["try 1", "try 2"]);
  });

  test("a permanent failure and a give-up end the timeline with the reason", async () => {
    const hard = await addPaste();
    const a = setup();
    a.fake.failNext("createDraft", classifyHttp(400));
    await processEnquiry(hard, a.deps);
    expect((await events(hard)).at(-1)).toEqual({ step: "failed", outcome: "permanent: bad_request_400" });

    const tired = await addPaste(email.body, "Bo <bo@other.example.com>");
    await sql`UPDATE enquiries SET tries = ${MAX_TRIES - 1} WHERE id = ${tired}`;
    const b = setup();
    b.fake.failNext("createDraft", classifyHttp(503));
    await processEnquiry(tired, b.deps);
    expect((await events(tired)).at(-1)).toEqual({ step: "failed", outcome: `gave up after ${MAX_TRIES} tries: retryable: upstream_503` });
  });

  test("output the model could not shape is visible as such", async () => {
    const id = await addPaste();
    const invalid = vi.fn(async () => ({ status: "invalid" as const, reason: "No object generated", meta: { model: "m", promptVersion: "v2", ms: 1, attempts: 2 } }));
    await processEnquiry(id, setup({ extract: invalid as unknown as Deps["extract"] }).deps);
    expect(await events(id)).toEqual(expect.arrayContaining([{ step: "extracted", outcome: "invalid output" }, { step: "done", outcome: "needs_review" }]));
  });

  test("a repeat of an earlier email shows that its draft was reused", async () => {
    const first = await addCopyForTimeline();
    const second = await addCopyForTimeline();
    const { deps } = setup();
    await processEnquiry(first, deps);
    await processEnquiry(second, deps);
    expect(await steps(second)).toEqual(["received", "claimed", "body_fetched", "draft_found", "done"]);
    expect((await events(second)).find((e) => e.step === "draft_found")!.outcome).toContain("same email as");
  });

  test("a crash right after create still shows the draft was created: events are written as each step ends, not batched", async () => {
    const id = await addPaste();
    const { deps } = setup({ faults: { afterCreate: () => { throw new SimulatedCrash("after create"); } } });
    await expect(processEnquiry(id, deps)).rejects.toBeInstanceOf(SimulatedCrash);
    const seen = await steps(id);
    expect(seen).toContain("draft_created");
    expect(seen).not.toContain("done");
  });

  test("a second delivery of the same email adds no second 'received'", async () => {
    const messageId = `<dup${counter++}@example>`;
    const a = await insertEnquiry({ messageId, source: "email", emailId: "em_1", sender: SENDER });
    const b = await insertEnquiry({ messageId, source: "email", emailId: "em_1", sender: SENDER });
    expect(b).toEqual({ id: a.id, created: false });
    expect(await steps(a.id)).toEqual(["received"]);
  });

  test("events never contain the email's words", async () => {
    const id = await addPaste();
    const { fake, deps } = setup();
    fake.failNext("createDraft", classifyHttp(503));
    await processEnquiry(id, deps);
    await makeDue(id);
    await processEnquiry(id, deps);
    const all = (await events(id)).map((e) => `${e.step} ${e.outcome}`).join(" ");
    for (const word of ["24 people", "Hi,", email.subject]) expect(all).not.toContain(word);
  });

  test("an event that cannot be written never fails the enquiry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await sql`ALTER TABLE events RENAME TO events_away`;
    try {
      const id = await addPaste();
      expect(await processEnquiry(id, setup().deps)).toBe("draft_created");
      expect((await row(id)).status).toBe("draft_created");
      expect(console.error).toHaveBeenCalledWith("events: insert failed", expect.objectContaining({ step: "claimed" }));
    } finally {
      await sql`ALTER TABLE events_away RENAME TO events`;
    }
  });
});

// Two emails with the same sender and words but different message ids, as a person sending it twice would.
async function addCopyForTimeline() {
  return (await insertEnquiry({ messageId: `<tl${counter++}@example>`, source: "email", emailId: "em_x", subject: email.subject, sender: SENDER })).id;
}
