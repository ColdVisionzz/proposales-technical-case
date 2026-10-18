import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { loadDotEnv, requireEnv } from "../lib/db/env";
import { migrate } from "../lib/db/migrate";

// The pipeline calls db(); here it returns the test branch connection.
let current: postgres.Sql;
vi.mock("../lib/db/client", () => ({ db: () => current }));

import { claimEnquiry, finishDraft, insertEnquiry, LostLeaseError, saveBody } from "../lib/db/enquiries";
import { MAX_EMAIL_CHARS } from "../lib/email/text";
import { classifyHttp, GatewayError } from "../lib/proposales/errors";
import { createFakeGateway } from "../lib/proposales/fake";
import { processEnquiry, RETRY_DELAY_SECONDS, type Deps } from "../lib/pipeline/process";
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
  await sql`DROP TABLE IF EXISTS events, enquiries, schema_migrations CASCADE`;
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
const addPaste = async (body = email.body) =>
  (await insertEnquiry({ messageId: `paste:${counter++}`, source: "paste", subject: email.subject, body, sender: SENDER })).id;
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
  const deps: Deps = {
    fetchBody,
    extract: extractFn as unknown as Deps["extract"],
    gateway: fake.gateway,
    companyId: 1001,
    today: () => TODAY,
    ...overrides,
  };
  return { fake, extractFn, fetchBody, deps };
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
        { content_id: 3001, quantity: 1 },
        { content_id: 3002, quantity: 24 },
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
    expect(await claimEnquiry(id)).toMatchObject({ attempt: 1 });
    expect(await claimEnquiry(id)).toBeNull(); // lease still running
    await sql`UPDATE enquiries SET locked_until = now() - interval '1 second' WHERE id = ${id}`;
    expect(await claimEnquiry(id)).toMatchObject({ attempt: 2 }); // worker crashed, lease ran out
  });

  test("a retrying row is claimable only once its time has come", async () => {
    const id = await addPaste();
    await sql`UPDATE enquiries SET status = 'retrying', next_attempt_at = now() + interval '1 minute' WHERE id = ${id}`;
    expect(await claimEnquiry(id)).toBeNull();
    await makeDue(id);
    expect(await claimEnquiry(id)).not.toBeNull();
  });

  test.each(["draft_created", "needs_review", "failed_permanent", "ignored"])("a %s row is never claimed again", async (status) => {
    const id = await addPaste();
    await sql`UPDATE enquiries SET status = ${status} WHERE id = ${id}`;
    expect(await claimEnquiry(id)).toBeNull();
  });

  test("an unknown id claims nothing", async () => {
    expect(await claimEnquiry("0b9f4c2e-6d1a-4f4e-9a52-3c1d2e7a8b90")).toBeNull();
  });
});

// ---- the fencing check -------------------------------------------------------------------------------------------

describe("a worker that lost its lease cannot write", () => {
  test("a stale attempt number is refused by every write, a current one is accepted", async () => {
    const id = await addPaste();
    await claimEnquiry(id); // attempt 1
    await sql`UPDATE enquiries SET locked_until = now() - interval '1 second' WHERE id = ${id}`;
    await claimEnquiry(id); // attempt 2 takes over
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
      expect(await claimEnquiry(id)).toMatchObject({ attempt: 2 });
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
    expect(secs).toBeGreaterThan(RETRY_DELAY_SECONDS - 5);
    expect(secs).toBeLessThanOrEqual(RETRY_DELAY_SECONDS);
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
