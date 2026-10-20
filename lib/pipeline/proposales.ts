import catalogSample from "../../fixtures/catalog.sample.json";
import { createProposalesClient } from "../proposales/client";
import { createFakeGateway } from "../proposales/fake";
import type { CatalogItem, ProposalesGateway } from "../proposales/gateway";

let real: ProposalesGateway | undefined;
let fake: ProposalesGateway | undefined;

// With PROPOSALES_API_KEY set this is the real Proposales client. Without it the in-memory fake stands in.
// On Vercel the fake only lives as long as one warm function instance, so it forgets drafts between requests:
// the "draft" a fake run reports is not a real Proposales draft, and duplicate protection is proven by the tests only.
export function getGateway(): ProposalesGateway {
  const apiKey = process.env.PROPOSALES_API_KEY;
  if (apiKey) return (real ??= createProposalesClient({ apiKey, baseUrl: process.env.PROPOSALES_BASE_URL || undefined }));
  console.warn("pipeline: using the in-memory fake gateway, no real draft is created");
  return (fake ??= createFakeGateway(catalogSample.data as CatalogItem[]).gateway);
}
