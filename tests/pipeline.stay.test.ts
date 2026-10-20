import { describe, expect, test } from "vitest";
import { policy } from "@/lib/extraction/policy";
import type { Extraction } from "@/lib/extraction/schema";
import { validate } from "@/lib/extraction/validate";
import { buildDraft } from "@/lib/pipeline/draft";
import { catalog, clean, f, TODAY } from "./extraction.fixtures";

const stayEmail = {
  subject: "Offsite",
  body: "Hi, 10 people, 5 rooms, from 10 March 2027 to 15 March 2027, with lunch and dinner for 5 of us, and a meeting room. Anna from Northwind AB",
};
const stayDraft = (overrides: Partial<Extraction>) => {
  const validated = validate(
    clean({
      guests: f(10, "10 people"),
      rooms: f(5, "5 rooms"),
      startDate: f("2027-03-10", "10 March 2027"),
      endDate: f("2027-03-15", "15 March 2027"),
      language: f("en", "Hi, 10 people"),
      ...overrides,
    }),
    stayEmail,
    catalog,
    TODAY,
    policy,
  );
  return buildDraft({ enquiryKey: "11111111-2222-4333-8444-555555555555", companyId: 1001, validated, flags: validated.flags, catalog, sender: null });
};
const product = (variationId: number, evidence: string, quantity: number | null = null, quantityEvidence: string | null = null) => ({ variationId, confidence: 1, evidence, quantity, quantityEvidence });
const quantities = (d: ReturnType<typeof stayDraft>) => Object.fromEntries((d.draft.blocks ?? []).map((b) => [b.content_id, b.quantity]));

describe("buildDraft quantities for a multi-night stay", () => {
  test("5 rooms for 5 nights is 25, the meeting room is 6 days, lunch is guests x days", () => {
    const d = stayDraft({ products: [product(3003, "5 rooms"), product(3001, "a meeting room"), product(3002, "lunch")] });
    expect(quantities(d)).toEqual({ 3003: 25, 3001: 6, 3002: 60 });
    expect(d.draft.description_md).toContain("- Rooms: 5 (5 nights)");
  });

  test("dinner for 5 of 10 guests: the stated total replaces guests x days, with no assumption note for it", () => {
    const d = stayDraft({ products: [product(3003, "5 rooms"), product(3004, "dinner", 5, "dinner for 5 of us")] });
    expect(quantities(d)).toEqual({ 3003: 25, 3004: 5 });
    expect(d.notes).toEqual([]);
  });

  test("a stated quantity the email does not back falls back to the default and tells the salesperson", () => {
    const d = stayDraft({ products: [product(3004, "dinner", 5, "5 guests want dinner")] });
    expect(quantities(d)).toEqual({ 3004: 60 });
    expect(d.draft.description_md).toContain("stated quantity 5 ignored");
    expect(d.draft.description_md).toContain("assumed all 10 guests");
  });

  test("rooms in the email but no hotel room product adds a note", () => {
    const d = stayDraft({ products: [product(3001, "a meeting room")] });
    expect(d.notes.map((n) => n.message)).toEqual([expect.stringContaining("no hotel room product is in the draft")]);
  });

  test("more rooms than guests adds a note", () => {
    const d = stayDraft({ rooms: f(12, "5 rooms"), products: [product(3003, "5 rooms")] });
    expect(d.notes.map((n) => n.message)).toEqual([expect.stringContaining("more rooms than guests")]);
  });
});
