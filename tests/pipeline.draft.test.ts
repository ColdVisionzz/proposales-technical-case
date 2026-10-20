import { describe, expect, test } from "vitest";
import { policy } from "@/lib/extraction/policy";
import type { Extraction } from "@/lib/extraction/schema";
import { validate } from "@/lib/extraction/validate";
import { ceilingFor, resolveQuantity, stayOf } from "@/lib/extraction/quantity";
import { buildDraft, parseSender } from "@/lib/pipeline/draft";
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

const stay = (start: string | null, end: string | null, nights: number | null = null) => stayOf(start, end, nights);
const FIVE_NIGHTS = { guests: 10, rooms: 5, stay: stay("2027-03-10", "2027-03-15") };

describe("stayOf", () => {
  test("event days run start to end inclusive, nights stop at the departure day", () => {
    expect(stay("2027-03-10", "2027-03-15")).toEqual({ days: 6, nights: 5, mismatch: false });
  });
  test("a one-day event has 1 day and 0 nights", () => expect(stay("2027-03-10", "2027-03-10")).toEqual({ days: 1, nights: 0, mismatch: false }));
  test("no end date: 1 day, nights unknown", () => expect(stay("2027-03-10", null)).toEqual({ days: 1, nights: null, mismatch: false }));
  test("nights stated in the email win (early arrival) and the difference is reported", () => {
    expect(stay("2027-03-10", "2027-03-12", 3)).toEqual({ days: 3, nights: 3, mismatch: true });
  });
  test("a stated 0 nights is not a stay, the dates decide", () => expect(stay("2027-03-10", "2027-03-12", 0).nights).toBe(2));
  test("an end before the start is not trusted", () => expect(stay("2027-03-12", "2027-03-10")).toEqual({ days: 1, nights: null, mismatch: false }));
});

describe("resolveQuantity", () => {
  test("5 rooms for 5 nights is 25 room-nights", () => expect(resolveQuantity("Hotel room", FIVE_NIGHTS).quantity).toBe(25));
  test("a meeting room and an AV package are per event day", () => {
    expect(resolveQuantity("Meeting room", FIVE_NIGHTS).quantity).toBe(6);
    expect(resolveQuantity("AV package", FIVE_NIGHTS).quantity).toBe(6);
  });
  test("meals are per guest per day, with a note when the days are more than one", () => {
    const lunch = resolveQuantity("Lunch", FIVE_NIGHTS);
    expect(lunch.quantity).toBe(60);
    expect(lunch.notes).toEqual([expect.stringContaining("assumed all 10 guests on each of 6 days")]);
    expect(resolveQuantity("Dinner", { ...FIVE_NIGHTS, stay: stay("2027-03-10", "2027-03-10") })).toEqual({ quantity: 10, notes: [] });
  });
  test("a product with no rule defaults to one; the title match ignores case and spaces", () => {
    expect(resolveQuantity("Spa", FIVE_NIGHTS).quantity).toBe(1);
    expect(resolveQuantity("  LUNCH ", { ...FIVE_NIGHTS, stay: stay("2027-03-10", "2027-03-10") }).quantity).toBe(10);
  });
  test("a room product without a room count falls back to 1 and says so", () => {
    expect(resolveQuantity("Hotel room", { ...FIVE_NIGHTS, rooms: null })).toEqual({ quantity: 1, notes: [expect.stringContaining("no room count")] });
  });
  test("rooms with no end date or a single-day event never come out as 0 nights", () => {
    const noEnd = resolveQuantity("Hotel room", { ...FIVE_NIGHTS, stay: stay("2027-03-10", null) });
    expect(noEnd).toEqual({ quantity: 5, notes: [expect.stringContaining("one night assumed")] });
    const sameDay = resolveQuantity("Hotel room", { ...FIVE_NIGHTS, stay: stay("2027-03-10", "2027-03-10") });
    expect(sameDay).toEqual({ quantity: 5, notes: [expect.stringContaining("single day")] });
  });
  test("nights that differ from the dates are used and noted", () => {
    const r = resolveQuantity("Hotel room", { ...FIVE_NIGHTS, rooms: 2, stay: stay("2027-03-10", "2027-03-12", 3) });
    expect(r).toEqual({ quantity: 6, notes: [expect.stringContaining("differ")] });
  });
  test("a stated quantity replaces the default rule and needs no note", () => {
    expect(resolveQuantity("Dinner", FIVE_NIGHTS, 5)).toEqual({ quantity: 5, notes: [] });
  });
  test("ceilings: rooms x nights, guests x days, guests", () => {
    expect(ceilingFor("Hotel room", FIVE_NIGHTS)).toBe(25);
    expect(ceilingFor("Dinner", FIVE_NIGHTS)).toBe(60);
    expect(ceilingFor("Spa", FIVE_NIGHTS)).toBe(10);
  });
});

describe("buildDraft", () => {
  test("the key travels in data, the company and language are set, and blocks use the catalog ids with quantities", () => {
    const { draft } = draftFor({ products: [{ variationId: 3001, confidence: 1, evidence: "a meeting room", quantity: null, quantityEvidence: null }, { variationId: 3002, confidence: 1, evidence: "lunch", quantity: null, quantityEvidence: null }] });
    expect(draft).toMatchObject({
      company_id: 1001,
      language: "en",
      data: { enquiry_key: KEY },
      blocks: [
        { type: "product-block", content_id: 3001, quantity: 2 }, // 12-13 March: 2 event days
        { type: "product-block", content_id: 3002, quantity: 48 }, // 24 guests x 2 days
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
    const { notes, draft } = draftFor({ products: [{ variationId: 3001, confidence: 1, evidence: "a meeting room", quantity: null, quantityEvidence: null }, { variationId: 3003, confidence: 1, evidence: "lunch", quantity: null, quantityEvidence: null }] });
    expect(notes).toHaveLength(1);
    expect(draft.description_md).toContain('"Hotel room" is priced per room per night but the email gives no room count: quantity set to 1, check it');
  });
});
