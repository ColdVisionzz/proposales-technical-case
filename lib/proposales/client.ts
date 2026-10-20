import type { components } from "./api-types";
import { classifyError, classifyHttp, GatewayError } from "./errors";
import { ENQUIRY_KEY, type CatalogItem, type CreateDraftInput, type Draft, type ProposalesGateway } from "./gateway";

// The real Proposales client. Request and response shapes come from fixtures/proposales/openapi.json and the answers
// the probe recorded in fixtures/proposales/real/. Every failure leaves here as a GatewayError, classified by errors.ts.
// The client never retries: the queue and its backoff decide that.
//
// Facts the probe measured (2026-10-19) that shape this file:
// - POST /v3/proposals is not idempotent. The caller must search first.
// - content_id takes a variation_id. A product_id is accepted but gives a draft with zero blocks and no error.
// - A fresh draft is searchable after about 0.2 s, by data.enquiry_key and by recipient email.

type SearchResult = components["schemas"]["ProposalSearchResult"];

export type ClientOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const unexpected = (what: string) => new GatewayError({ kind: "permanent", reason: "unexpected_response" }, { cause: new Error(what) });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function createProposalesClient(options: ClientOptions): ProposalesGateway {
  if (!options.apiKey) throw new Error("createProposalesClient: apiKey is empty");
  const base = options.baseUrl ?? "https://api.proposales.com";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const doFetch = options.fetchImpl ?? fetch;

  // One request. Returns the parsed JSON of a 2xx answer; throws a GatewayError for everything else.
  async function call(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<unknown> {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${options.apiKey}` };
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    let status: number;
    let retryAfter: string | null;
    let text: string;
    try {
      // The timeout covers reading the body too, so a stalled response cannot hang a worker.
      const res = await doFetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      retryAfter = res.headers.get("retry-after");
      text = await res.text();
    } catch (error) {
      throw new GatewayError(classifyError(error), { cause: error });
    }

    if (status < 200 || status >= 300) {
      const failure = classifyHttp(status, retryAfter);
      // ponytail: first 200 chars of the response, whitespace flattened; Proposales errors name fields, not our email text
      throw new GatewayError(failure.kind === "permanent" && status !== 401 && status !== 403 ? { ...failure, detail: text.replace(/\s+/g, " ").trim().slice(0, 200) } : failure);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw unexpected(`${method} ${path}: HTTP ${status} body is not JSON`);
    }
  }

  const dataArray = (body: unknown, what: string): unknown[] => {
    if (!isObject(body) || !Array.isArray(body.data)) throw unexpected(`${what}: no data array`);
    return body.data;
  };

  // Of several drafts with our key (the probe showed two are possible), the oldest wins, so every caller agrees.
  const oldest = (hits: SearchResult[]): Draft | null => {
    const first = [...hits].sort((a, b) => a.created_at - b.created_at || a.uuid.localeCompare(b.uuid))[0];
    return first ? { uuid: first.uuid, url: first.url } : null;
  };

  // A search hit we may rely on: right shape, and the key really is ours. The query filter is not trusted on its own.
  const matching = (items: unknown[], enquiryKey: string): SearchResult[] =>
    items.filter(
      (item): item is SearchResult =>
        isObject(item) &&
        typeof item.uuid === "string" &&
        typeof item.url === "string" &&
        typeof item.created_at === "number" &&
        isObject(item.data) &&
        item.data[ENQUIRY_KEY] === enquiryKey,
    );

  return {
    async getCatalog() {
      const items = dataArray(await call("GET", "/v3/content"), "GET /v3/content");
      return items.filter((item): item is CatalogItem => {
        if (!isObject(item) || typeof item.product_id !== "number" || typeof item.variation_id !== "number" || !isObject(item.title)) {
          throw unexpected("GET /v3/content: an item has no ids or title");
        }
        return item.deactivated_at == null; // a deactivated product must not end up in a draft
      });
    },

    async findExistingDraft(enquiryKey, recipientEmail) {
      const byKey = await call("GET", "/v3/proposal-search", { query: { [`filter[${ENQUIRY_KEY}]`]: enquiryKey, limit: "25" } });
      const found = oldest(matching(dataArray(byKey, "proposal-search by key"), enquiryKey));
      if (found || !recipientEmail) return found;

      const byEmail = await call("GET", "/v3/proposal-search", { query: { recipient_email: recipientEmail, limit: "25" } });
      return oldest(matching(dataArray(byEmail, "proposal-search by email"), enquiryKey));
    },

    async createDraft(input: CreateDraftInput) {
      const body = await call("POST", "/v3/proposals", { body: input });
      const proposal = isObject(body) ? body.proposal : undefined;
      if (!isObject(proposal) || typeof proposal.uuid !== "string" || typeof proposal.url !== "string") {
        // The draft may exist. That is safe: the retry searches by enquiry_key before it creates.
        throw unexpected("POST /v3/proposals: no proposal.uuid or proposal.url");
      }
      return { uuid: proposal.uuid, url: proposal.url };
    },
  };
}
