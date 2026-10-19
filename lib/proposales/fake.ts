import { GatewayError, type Failure } from "./errors";
import { ENQUIRY_KEY, type CatalogItem, type CreateDraftInput, type Draft, type ProposalesGateway } from "./gateway";

type Method = "getCatalog" | "findExistingDraft" | "createDraft";

// In-memory stand-in for Proposales. Like the real API it has no idempotency: creating twice
// with the same enquiry_key makes two drafts, so only search-before-create prevents duplicates.
export function createFakeGateway(catalog: CatalogItem[] = []) {
  const drafts: Array<Draft & { input: CreateDraftInput }> = [];
  const failures: Record<Method, Failure[]> = { getCatalog: [], findExistingDraft: [], createDraft: [] };
  let crashAfterCreate = 0;
  let missKeySearch = 0;

  const emailOf = (input: CreateDraftInput) =>
    input.recipient && "email" in input.recipient ? input.recipient.email?.toLowerCase() : undefined;
  const throwQueued = (method: Method) => {
    const failure = failures[method].shift();
    if (failure) throw new GatewayError(failure);
  };

  const gateway: ProposalesGateway = {
    async getCatalog() {
      throwQueued("getCatalog");
      return structuredClone(catalog);
    },

    async findExistingDraft(enquiryKey, recipientEmail) {
      throwQueued("findExistingDraft");
      const hasKey = (d: (typeof drafts)[number]) => d.input.data?.[ENQUIRY_KEY] === enquiryKey;
      // A search miss only hits the key search (index lag, or data not searchable). The email fallback still runs.
      const byKey = missKeySearch > 0 ? (missKeySearch--, undefined) : drafts.find(hasKey);
      const found =
        byKey ?? (recipientEmail ? drafts.find((d) => emailOf(d.input) === recipientEmail.toLowerCase() && hasKey(d)) : undefined);
      return found ? { uuid: found.uuid, url: found.url } : null;
    },

    async createDraft(input) {
      throwQueued("createDraft");
      const uuid = crypto.randomUUID();
      const draft = { uuid, url: `https://fake.proposales.test/proposals/${uuid}/edit`, input: structuredClone(input) };
      drafts.push(draft);
      if (crashAfterCreate > 0) {
        crashAfterCreate--;
        // The draft exists at "Proposales" but the caller never learns its uuid.
        throw new GatewayError({ kind: "retryable", reason: "connection_lost_after_create" });
      }
      return { uuid, url: draft.url };
    },
  };

  return {
    gateway,
    drafts,
    // The next call to `method` throws a GatewayError carrying `failure`. Calls queue in order.
    failNext: (method: Method, failure: Failure) => void failures[method].push(failure),
    // The next createDraft stores the draft, then throws as if the response was lost.
    crashAfterNextCreate: () => void crashAfterCreate++,
    // The next findExistingDraft key search finds nothing, even if the draft exists.
    missNextKeySearch: () => void missKeySearch++,
  };
}
