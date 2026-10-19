import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createProposalesClient } from "@/lib/proposales/client";
import { GatewayError, type Failure } from "@/lib/proposales/errors";
import type { CreateDraftInput } from "@/lib/proposales/gateway";
import { gatewayContract } from "./proposales.contract";

// The client is tested against what the live API really returned (fixtures/proposales/real/), through an injected fetch.
// No test here talks to the network.
const real = (file: string) => JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "proposales", "real", file), "utf8"));
const API_KEY = "test-key-not-a-secret";
const KEY = real("search-by-data.200.json").data[0].data.enquiry_key as string;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

type Call = { method: string; path: string; query: URLSearchParams; headers: Headers; body: unknown };
// A fetch that records every call and answers with whatever `answer` returns.
function stub(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, client: createProposalesClient({ apiKey: API_KEY, baseUrl: "https://api.example.test", fetchImpl, timeoutMs: 200 }) };
}

async function failureOf(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as Error).message).not.toContain(API_KEY); // an error text must never carry the key
    return (error as GatewayError).failure;
  }
  throw new Error("expected the call to throw");
}

describe("getCatalog", () => {
  test("replays the real catalog and sends the bearer key", async () => {
    const { client, calls } = stub(() => json(real("content.200.json")));
    const items = await client.getCatalog();
    expect(items.map((i) => i.title.en?.trim())).toEqual(real("content.200.json").data.map((i: { title: { en: string } }) => i.title.en));
    expect(items.every((i) => typeof i.variation_id === "number" && typeof i.product_id === "number")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v3/content" });
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  });

  test("a deactivated product is left out, so it cannot end up in a draft", async () => {
    const body = real("content.200.json");
    body.data[1].deactivated_at = 1792399999999;
    const items = await stub(() => json(body)).client.getCatalog();
    expect(items).toHaveLength(body.data.length - 1);
    expect(items.map((i) => i.variation_id)).not.toContain(body.data[1].variation_id);
  });

  test("an item without ids is a permanent unexpected_response, not a silent skip", async () => {
    const body = { data: [{ title: { en: "No ids" } }] };
    expect(await failureOf(stub(() => json(body)).client.getCatalog())).toEqual({ kind: "permanent", reason: "unexpected_response" });
  });
});

describe("findExistingDraft", () => {
  test("finds the real draft by enquiry_key and asks for the key filter", async () => {
    const { client, calls } = stub(() => json(real("search-by-data.200.json")));
    const draft = await client.findExistingDraft(KEY);
    const hit = real("search-by-data.200.json").data[0];
    expect(draft).toEqual({ uuid: hit.uuid, url: hit.url });
    expect(calls[0].path).toBe("/v3/proposal-search");
    expect(calls[0].query.get("filter[enquiry_key]")).toBe(KEY);
    expect(calls).toHaveLength(1); // a hit by key needs no email search
  });

  test("two drafts with our key (the real API made a second one): the oldest wins, whatever the order", async () => {
    const both = real("search-by-data-after-duplicate.200.json");
    const oldest = [...both.data].sort((a: { created_at: number }, b: { created_at: number }) => a.created_at - b.created_at)[0];
    expect(both.data[0].uuid).not.toBe(oldest.uuid); // the real answer lists the newer draft first
    const draft = await stub(() => json(both)).client.findExistingDraft(KEY);
    expect(draft?.uuid).toBe(oldest.uuid);
  });

  test("a draft with another key is never adopted, even if the server ignored the filter", async () => {
    const { client } = stub(() => json(real("search-by-data.200.json")));
    expect(await client.findExistingDraft("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await client.findExistingDraft("00000000-0000-4000-8000-000000000000", "probe-a@example.com")).toBeNull();
  });

  test("when the key search finds nothing, the recipient email search runs and its hit is checked for our key", async () => {
    const { client, calls } = stub((call) => (call.query.has("recipient_email") ? json(real("search-by-recipient.200.json")) : json({ data: [] })));
    const draft = await client.findExistingDraft(KEY, "probe-a@example.com");
    expect(draft?.uuid).toBe(real("search-by-recipient.200.json").data[0].uuid);
    expect(calls.map((c) => c.query.has("recipient_email"))).toEqual([false, true]);
    expect(calls[1].query.get("recipient_email")).toBe("probe-a@example.com");
  });

  test("an empty answer is null", async () => {
    expect(await stub(() => json({ data: [] })).client.findExistingDraft(KEY, "a@b.example")).toBeNull();
  });

  test("an answer without a data array is a permanent unexpected_response", async () => {
    expect(await failureOf(stub(() => json({ oops: true })).client.findExistingDraft(KEY))).toEqual({ kind: "permanent", reason: "unexpected_response" });
  });
});

describe("createDraft", () => {
  const request = real("create-proposal.request.json") as CreateDraftInput;

  test("posts the request as given and returns the real uuid and url", async () => {
    const { client, calls } = stub(() => json(real("create-proposal.200.json")));
    const draft = await client.createDraft(request);
    expect(draft).toEqual(real("create-proposal.200.json").proposal);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v3/proposals", body: request });
    expect(calls[0].headers.get("content-type")).toBe("application/json");
  });

  test("a 2xx answer without proposal.uuid is permanent, never a made-up draft", async () => {
    expect(await failureOf(stub(() => json({ proposal: {} })).client.createDraft(request))).toEqual({ kind: "permanent", reason: "unexpected_response" });
  });

  test("the client never retries by itself: a 500 means exactly one call", async () => {
    const { client, calls } = stub(() => json({ error: { message: "boom" } }, 500));
    await failureOf(client.createDraft(request));
    expect(calls).toHaveLength(1);
  });
});

describe("failures are classified in one place", () => {
  const request = real("create-proposal.request.json") as CreateDraftInput;
  const run = (answer: () => Response | Promise<Response>) => failureOf(stub(answer).client.createDraft(request));

  test("401 with the real body is permanent and loud", async () => {
    expect(await run(() => json(real("error.401.json"), 401))).toEqual({ kind: "permanent", reason: "auth", loud: true });
  });
  test("400 with the real body is permanent, never retried", async () => {
    expect(await run(() => json(real("error.400.json"), 400))).toEqual({ kind: "permanent", reason: "bad_request_400" });
  });
  test("429 is retryable and keeps Retry-After", async () => {
    expect(await run(() => json({ error: { message: "slow down" } }, 429, { "retry-after": "30" }))).toEqual({ kind: "retryable", reason: "rate_limited", retryAfterMs: 30_000 });
  });
  test("503 is retryable", async () => {
    expect(await run(() => json({}, 503))).toEqual({ kind: "retryable", reason: "upstream_503" });
  });
  test("a dropped connection is retryable", async () => {
    expect(await run(() => Promise.reject(new TypeError("fetch failed")))).toEqual({ kind: "retryable", reason: "network" });
  });
  test("a 200 that is not JSON is permanent", async () => {
    expect(await run(() => new Response("<html>gateway</html>", { status: 200 }))).toEqual({ kind: "permanent", reason: "unexpected_response" });
  });

  // The stub waits for the abort signal, like a server that never answers. Without a timeout this test would hang.
  test("a call that never answers is aborted and is a retryable timeout", async () => {
    const fetchImpl = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
    const client = createProposalesClient({ apiKey: API_KEY, fetchImpl, timeoutMs: 30 });
    expect(await failureOf(client.createDraft(request))).toEqual({ kind: "retryable", reason: "timeout" });
  });

  test("a body that stalls after the headers also times out", async () => {
    const fetchImpl = ((_: unknown, init?: RequestInit) =>
      Promise.resolve({
        status: 200,
        headers: new Headers(),
        text: () => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
      })) as unknown as typeof fetch;
    const client = createProposalesClient({ apiKey: API_KEY, fetchImpl, timeoutMs: 30 });
    expect(await failureOf(client.getCatalog())).toEqual({ kind: "retryable", reason: "timeout" });
  });
});

test("an empty api key is refused at construction", () => {
  expect(() => createProposalesClient({ apiKey: "" })).toThrow(/apiKey/);
});

// The same behaviour tests the in-memory fake passes, now over the real client and a small stateful server.
function statefulFetch(): typeof fetch {
  const drafts: Array<{ uuid: string; url: string; created_at: number; data: Record<string, string>; email?: string }> = [];
  return (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v3/content") return json(real("content.200.json"));
    if (url.pathname === "/v3/proposals" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as CreateDraftInput;
      const uuid = crypto.randomUUID();
      const draft = { uuid, url: `https://secure.example.test/proposals/${uuid}/edit`, created_at: Date.now() + drafts.length, data: (body.data ?? {}) as Record<string, string>, email: body.recipient && "email" in body.recipient ? body.recipient.email : undefined };
      drafts.push(draft);
      return json({ proposal: { uuid, url: draft.url } });
    }
    if (url.pathname === "/v3/proposal-search") {
      const key = url.searchParams.get("filter[enquiry_key]");
      const email = url.searchParams.get("recipient_email");
      const hits = drafts.filter((d) => (key && d.data.enquiry_key === key) || (email && d.email === email));
      return json({ data: hits.map((d) => ({ ...d, title: "t", series_uuid: d.uuid, company_id: 1, version: null, status: "draft" })) });
    }
    return json({ error: { message: "not found" } }, 404);
  }) as typeof fetch;
}

gatewayContract("real client over a stateful stub", () => createProposalesClient({ apiKey: API_KEY, baseUrl: "https://api.example.test", fetchImpl: statefulFetch() }));
