import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { classifyError, classifyHttp, GatewayError, parseRetryAfter } from "@/lib/proposales/errors";
import { createFakeGateway } from "@/lib/proposales/fake";
import type { CatalogItem, CreateDraftInput } from "@/lib/proposales/gateway";
import { gatewayContract } from "./proposales.contract";

const synthetic = (file: string) => JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "proposales", "synthetic", file), "utf8"));
const catalog = synthetic("content.200.json").data as CatalogItem[];
const request = synthetic("create-proposal.request.json") as CreateDraftInput;
const email = "sam@acme.example.com"; // the recipient in create-proposal.request.json
const draftFor = (key: string, recipientEmail = email): CreateDraftInput => ({
  ...request,
  recipient: { email: recipientEmail },
  data: { enquiry_key: key },
});

describe("classifyHttp: one test per failure-matrix row", () => {
  test("429 is retryable and honours Retry-After", () => {
    expect(classifyHttp(429, "30")).toEqual({ kind: "retryable", reason: "rate_limited", retryAfterMs: 30_000 });
  });
  test("429 without Retry-After is still retryable", () => {
    expect(classifyHttp(429, null)).toMatchObject({ kind: "retryable", reason: "rate_limited", retryAfterMs: undefined });
  });
  test.each([500, 502, 503, 504])("%i is retryable", (status) => {
    expect(classifyHttp(status)).toEqual({ kind: "retryable", reason: `upstream_${status}` });
  });
  test.each([401, 403])("%i is permanent and loud", (status) => {
    expect(classifyHttp(status)).toEqual({ kind: "permanent", reason: "auth", loud: true });
  });
  test.each([400, 404, 408, 409, 422])("%i is permanent, never retried", (status) => {
    expect(classifyHttp(status)).toEqual({ kind: "permanent", reason: `bad_request_${status}` });
  });
});

describe("parseRetryAfter", () => {
  test("seconds", () => expect(parseRetryAfter("120")).toBe(120_000));
  test("HTTP date", () => {
    const ms = parseRetryAfter(new Date(Date.now() + 60_000).toUTCString());
    expect(ms).toBeGreaterThan(55_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });
  test("a date in the past gives 0, not a negative wait", () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });
  test.each([undefined, null, "", "soon", "-5"])("garbage %s gives undefined and does not throw", (value) => {
    expect(parseRetryAfter(value)).toBeUndefined();
  });
});

describe("classifyError", () => {
  test("a GatewayError keeps its own failure", () => {
    const failure = { kind: "permanent", reason: "auth", loud: true } as const;
    expect(classifyError(new GatewayError(failure))).toEqual(failure);
  });
  test.each(["AbortError", "TimeoutError"])("%s is a retryable timeout", (name) => {
    expect(classifyError(new DOMException("took too long", name))).toEqual({ kind: "retryable", reason: "timeout" });
  });
  test("a dropped connection is a retryable network error", () => {
    expect(classifyError(new TypeError("fetch failed"))).toEqual({ kind: "retryable", reason: "network" });
  });
  test("our own bugs are permanent, not retried", () => {
    expect(classifyError(new TypeError("x is not a function"))).toEqual({ kind: "permanent", reason: "unknown" });
    expect(classifyError(new Error("boom"))).toEqual({ kind: "permanent", reason: "unknown" });
    expect(classifyError("a string")).toEqual({ kind: "permanent", reason: "unknown" });
  });
});

gatewayContract("fake", () => createFakeGateway(catalog).gateway);

describe("fake gateway: failure injection", () => {
  test("a queued retryable failure hits the next call only", async () => {
    const fake = createFakeGateway(catalog);
    fake.failNext("createDraft", classifyHttp(503));
    const error = await fake.gateway.createDraft(draftFor("k1")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).failure).toEqual({ kind: "retryable", reason: "upstream_503" });
    expect(fake.drafts).toHaveLength(0);
    await expect(fake.gateway.createDraft(draftFor("k1"))).resolves.toHaveProperty("uuid");
  });

  test("a permanent failure carries kind and loud flag", async () => {
    const fake = createFakeGateway(catalog);
    fake.failNext("getCatalog", classifyHttp(401));
    await expect(fake.gateway.getCatalog()).rejects.toMatchObject({ failure: { kind: "permanent", reason: "auth", loud: true } });
  });

  test("a timeout is a retryable failure", async () => {
    const fake = createFakeGateway(catalog);
    fake.failNext("findExistingDraft", classifyError(new DOMException("slow", "TimeoutError")));
    await expect(fake.gateway.findExistingDraft("k1")).rejects.toMatchObject({ failure: { kind: "retryable", reason: "timeout" } });
  });

  test("failures only hit the method they were queued for, in order", async () => {
    const fake = createFakeGateway(catalog);
    fake.failNext("createDraft", classifyHttp(500));
    fake.failNext("createDraft", classifyHttp(429, "5"));
    await expect(fake.gateway.getCatalog()).resolves.toHaveLength(catalog.length);
    await expect(fake.gateway.createDraft(draftFor("k1"))).rejects.toMatchObject({ failure: { reason: "upstream_500" } });
    await expect(fake.gateway.createDraft(draftFor("k1"))).rejects.toMatchObject({ failure: { reason: "rate_limited", retryAfterMs: 5000 } });
  });

  test("crash after create: the call throws but the draft exists and can be found", async () => {
    const fake = createFakeGateway(catalog);
    fake.crashAfterNextCreate();
    await expect(fake.gateway.createDraft(draftFor("k1"))).rejects.toMatchObject({ failure: { kind: "retryable" } });
    expect(fake.drafts).toHaveLength(1);
    expect(await fake.gateway.findExistingDraft("k1")).toEqual({ uuid: fake.drafts[0].uuid, url: fake.drafts[0].url });
  });

  test("a search miss hides the draft from the key search, so a blind retry would duplicate it", async () => {
    const fake = createFakeGateway(catalog);
    await fake.gateway.createDraft(draftFor("k1"));
    fake.missNextKeySearch();
    expect(await fake.gateway.findExistingDraft("k1")).toBeNull(); // the known gap, without an email
    await fake.gateway.createDraft(draftFor("k1"));
    expect(fake.drafts).toHaveLength(2);
  });

  test("a search miss is covered by the recipient-email fallback", async () => {
    const fake = createFakeGateway(catalog);
    const created = await fake.gateway.createDraft(draftFor("k1"));
    fake.missNextKeySearch();
    expect(await fake.gateway.findExistingDraft("k1", email.toUpperCase())).toEqual(created);
  });

  test("the email fallback ignores drafts with another key", async () => {
    const fake = createFakeGateway(catalog);
    await fake.gateway.createDraft(draftFor("other"));
    fake.missNextKeySearch();
    expect(await fake.gateway.findExistingDraft("k1", email)).toBeNull();
  });

  test("like the real API, creating twice with one key makes two drafts", async () => {
    const fake = createFakeGateway(catalog);
    await fake.gateway.createDraft(draftFor("k1"));
    await fake.gateway.createDraft(draftFor("k1"));
    expect(fake.drafts).toHaveLength(2);
  });
});
