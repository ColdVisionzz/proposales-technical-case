import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { CreateDraftInput, ProposalesGateway } from "@/lib/proposales/gateway";

// Behaviour every ProposalesGateway must have. Run it against the fake now and the real client
// later. Not a *.test.ts file, so vitest only runs it where a test file calls it.
// Only behaviour the real API also has belongs here. Search lag is not covered: against the real
// API a find right after create may need a short wait first.
const request = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "proposales", "synthetic", "create-proposal.request.json"), "utf8"),
) as CreateDraftInput;

const withKey = (key: string): CreateDraftInput => ({ ...request, data: { enquiry_key: key } });

export function gatewayContract(name: string, make: () => ProposalesGateway) {
  describe(`ProposalesGateway contract: ${name}`, () => {
    test("getCatalog returns items with product and variation ids", async () => {
      const items = await make().getCatalog();
      expect(Array.isArray(items)).toBe(true);
      for (const item of items) {
        expect(typeof item.product_id).toBe("number");
        expect(typeof item.variation_id).toBe("number");
      }
    });

    test("createDraft returns a uuid and a url", async () => {
      const draft = await make().createDraft(withKey(crypto.randomUUID()));
      expect(draft.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(draft.url).toMatch(/^https:\/\//);
    });

    test("findExistingDraft finds a draft by its enquiry_key", async () => {
      const gateway = make();
      const key = crypto.randomUUID();
      const created = await gateway.createDraft(withKey(key));
      expect(await gateway.findExistingDraft(key)).toEqual(created);
    });

    test("findExistingDraft returns null for an unknown key", async () => {
      expect(await make().findExistingDraft(crypto.randomUUID())).toBeNull();
    });

    test("findExistingDraft does not return a draft with another key", async () => {
      const gateway = make();
      await gateway.createDraft(withKey(crypto.randomUUID()));
      expect(await gateway.findExistingDraft(crypto.randomUUID(), request.recipient && "email" in request.recipient ? request.recipient.email : undefined)).toBeNull();
    });
  });
}
