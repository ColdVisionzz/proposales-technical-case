import type { components } from "./api-types";

type Schemas = components["schemas"];

export type CatalogItem = Schemas["ContentItem"];
export type CreateDraftInput = Schemas["CreateProposalRequest"];
export type Draft = { uuid: string; url: string };

// The key in `data` that links a draft to our enquiry row. The API has no idempotency key,
// so this is how we find a draft we already created.
export const ENQUIRY_KEY = "enquiry_key";

// Every method throws GatewayError on failure (see errors.ts) and never returns a half result.
export interface ProposalesGateway {
  getCatalog(): Promise<CatalogItem[]>;
  // Search by data.enquiry_key. If that finds nothing and an email is given, search by recipient
  // email and check the key on each result ourselves. Null means no draft carries this key.
  findExistingDraft(enquiryKey: string, recipientEmail?: string): Promise<Draft | null>;
  // Not idempotent: two calls make two drafts. Callers must search first.
  createDraft(input: CreateDraftInput): Promise<Draft>;
}
