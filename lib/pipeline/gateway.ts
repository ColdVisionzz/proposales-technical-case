import catalogSample from "../../fixtures/catalog.sample.json";
import { createFakeGateway } from "../proposales/fake";
import type { CatalogItem, ProposalesGateway } from "../proposales/gateway";

let fake: ProposalesGateway | undefined;

// The real client (T8b) waits for Proposales access. Until then the in-memory fake stands in.
// On Vercel the fake only lives as long as one warm function instance, so it forgets drafts between requests:
// the "draft" a live run reports is not a real Proposales draft, and duplicate protection is proven by the tests only.
export function getGateway(): ProposalesGateway {
  if (process.env.PROPOSALES_API_KEY) {
    throw new Error("PROPOSALES_API_KEY is set but the real Proposales client is not built yet (T8b)");
  }
  console.warn("pipeline: using the in-memory fake gateway, no real draft is created");
  return (fake ??= createFakeGateway(catalogSample.data as CatalogItem[]).gateway);
}
