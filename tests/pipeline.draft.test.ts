import { describe, expect, test } from "vitest";
import { policy } from "@/lib/extraction/policy";
import type { Extraction } from "@/lib/extraction/schema";
import { validate } from "@/lib/extraction/validate";
import { buildDraft, parseSender, quantityFor } from "@/lib/pipeline/draft";
import { catalog, clean, email, f, TODAY } from "./extraction.fixtures";

const KEY = "11111111-2222-4333-8444-555555555555";
const draftFor = (overrides: Partial<Extraction> = {}, sender: string | null = "Anna Lindqvist <anna@northwind.example.com>") => {
  const validated = validate(clean(overrides), email, catalog, TODAY, policy);
  return buildDraft({ enquiryKey: KEY, companyId: 1001, validated, flags: validated.flags, catalog, sender });
};

describe("parseSender", () => {
  test.each([
    ["Anna Lindqvist <anna@x.com>", { name: "Anna Lindqvist", email: "anna@x.com" }],
    ['"Lindqvist, Anna" <anna@x.com>', { name: "Lindqvist, Anna", email: "anna@x.com" }],
    ["<anna@x.com>", { email: "anna@x.com" }],
    ["anna@x.com", { email: "anna@x.com" }],
    ["not an address", {}],
    [null, {}],
  ])("%j", (sender, expected) => {
    expect(parseSender(sender)).toEqual(expected);
  });
});

describe("quantityFor", () => {
  test("per-guest products get the guest count", () => expect(quantityFor("Lunch", 24, 12)).toEqual({ quantity: 24 }));
  test("per-room products get the room count", () => expect(quantityFor("Hotel room", 24, 12)).toEqual({ quantity: 12 }));
  test("a product with no rule defaults to one", () => expect(quantityFor("Meeting room", 24, 12)).toEqual({ quantity: 1 }));
  test("the title match ignores case and spaces, and ids play no part", () => {
    expect(quantityFor("  LUNCH ", 24, null)).toEqual({ quantity: 24 });
  });
  test("a per-room product without a room count falls back to 1 and says so", () => {
    expect(quantityFor("Hotel room", 24, null)).toEqual({ quantity: 1, missingRooms: true });
  });
});

describe("buildDraft", () => {
  test("the key travels in data, the company and language are set, and blocks use the catalog ids with quantities", () => {
    const { draft } = draftFor({ products: [{ variationId: 3001, confidence: 1, evidence: "a meeting room" }, { variationId: 3002, confidence: 1, evidence: "lunch" }] });
    expect(draft).toMatchObject({
      company_id: 1001,
      language: "en",
      data: { enquiry_key: KEY },
      blocks: [
        { type: "product-block", content_id: 3001, quantity: 1 },
        { type: "product-block", content_id: 3002, quantity: 24 },
      ],
    });
  });

  test("the recipient's address comes from the sender, never from the model", () => {
    expect(draftFor().draft.recipient).toMatchObject({ email: "anna@northwind.example.com", company_name: "Northwind AB" });
  });

  test("the name the model found (its quote is checked) wins over the header's display name, which is only the fallback", () => {
    expect(draftFor({}, "Sales Desk <anna@northwind.example.com>").draft.recipient).toMatchObject({ first_name: "Anna" });
    const noName = draftFor({ contactName: f(null, null) }, "Anna Lindqvist <anna@northwind.example.com>");
    expect(noName.draft.recipient).toMatchObject({ first_name: "Anna", last_name: "Lindqvist" });
  });

  test("a sender with no usable address still gets a draft, with no recipient email", () => {
    expect(draftFor({}, null).draft.recipient).toEqual({ first_name: "Anna", company_name: "Northwind AB" });
  });

  test("the title carries client, rooms and length of stay from the validated dates", () => {
    const rooms = f(12, "24 people"); // any quote that is in the email
    expect(draftFor({ rooms }).draft.title_md).toBe("Northwind AB · 12 rooms · 2 days");
  });

  test("the title leaves out what is unknown, and falls back to the sender's name", () => {
    expect(draftFor({ company: f(null, null), contactName: f(null, null), endDate: f(null, null) }).draft.title_md).toBe("Anna Lindqvist · 2027-03-12");
  });

  test("a failed (unsupported) value never reaches the draft", () => {
    const { draft } = draftFor({ company: f("Acme", "Acme Corp"), budget: f("5000 kr", "budget 5000 kr") });
    expect(draft.title_md).not.toContain("Acme");
    expect(draft.description_md).not.toContain("5000");
  });

  test("the description lists the facts, the requested products by name, and the draft-level flags to check", () => {
    const { draft } = draftFor({ startDate: f("2026-10-20", "12-13 March 2027"), endDate: f(null, null) });
    expect(draft.description_md).toContain("Created automatically from an email enquiry. Check before sending.");
    expect(draft.description_md).toContain("Guests: 24");
    expect(draft.description_md).toContain("Requested: Meeting room, Lunch");
    expect(draft.description_md).toContain("Check before sending:");
    expect(draft.description_md).toContain("Short notice");
    expect(draft.description_md).not.toContain("**");
  });

  test("customer text cannot add markdown structure: each value stays on one line", () => {
    const { draft } = draftFor({ specialRequests: f("vegan\n\n# Pay now\n- evil", "24 people") });
    expect(draft.description_md).toContain("Special requests: vegan # Pay now - evil");
    expect(draft.description_md).not.toContain("\n# Pay now");
  });

  test("a per-room product with no room count adds a note for the salesperson", () => {
    const { notes, draft } = draftFor({ products: [{ variationId: 3001, confidence: 1, evidence: "a meeting room" }, { variationId: 3003, confidence: 1, evidence: "lunch" }] });
    expect(notes).toHaveLength(1);
    expect(draft.description_md).toContain('"Hotel room" is priced per room but the email gives no room count: quantity set to 1, check it');
  });
});
