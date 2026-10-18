import { describe, expect, test } from "vitest";
import { decide } from "@/lib/extraction/decide";
import { policy } from "@/lib/extraction/policy";
import type { Extraction } from "@/lib/extraction/schema";
import { validate } from "@/lib/extraction/validate";
import { catalog, clean, email, f, TODAY } from "./extraction.fixtures";

const decideFor = (overrides: Partial<Extraction> = {}, em = email) => decide(validate(clean(overrides), em, catalog, TODAY, policy));

// One test per row of the SPEC outcomes table.
describe("outcomes", () => {
  test("key fields found, confident, validations pass: draft", () => {
    expect(decideFor()).toEqual({ outcome: "draft", reasons: [] });
  });

  test("key fields found but a soft warning (short notice): flagged draft, with the reason", () => {
    const d = decideFor({ startDate: f("2026-10-20", "12-13 March 2027"), endDate: f(null, null) });
    expect(d.outcome).toBe("flagged_draft");
    expect(d.reasons[0]).toContain("Short notice");
  });

  test("key fields found but low confidence on an optional field: flagged draft", () => {
    expect(decideFor({ company: f("Northwind AB", "Northwind AB", 0.5) }).outcome).toBe("flagged_draft");
  });

  test("key fields found but only fairly sure (0.7): flagged draft", () => {
    expect(decideFor({ guests: f(24, "24 people", 0.7) }).outcome).toBe("flagged_draft");
  });

  test("a very large group: flagged draft", () => {
    expect(decideFor({ guests: f(500, "24 people") }).outcome).toBe("flagged_draft");
  });

  test("no start date: needs review, saying what is missing", () => {
    const d = decideFor({ startDate: f(null, null), endDate: f(null, null) });
    expect(d).toEqual({ outcome: "needs_review", reasons: ["Start date: not found in the email"] });
  });

  test("no guest count: needs review", () => {
    expect(decideFor({ guests: f(null, null) })).toEqual({ outcome: "needs_review", reasons: ["Guest count: not found in the email"] });
  });

  test("both missing: both are listed", () => {
    const d = decideFor({ startDate: f(null, null), guests: f(null, null) });
    expect(d.outcome).toBe("needs_review");
    expect(d.reasons).toHaveLength(2);
  });

  test("conflicting dates: needs review, with the conflict as the reason", () => {
    const d = decideFor({ endDate: f("2027-03-11", "12-13 March 2027") });
    expect(d.outcome).toBe("needs_review");
    expect(d.reasons[0]).toContain("Conflicting dates");
  });

  test("a critical quote that is not in the email: needs review, not a draft", () => {
    const d = decideFor({ guests: f(24, "twenty four of us") });
    expect(d.outcome).toBe("needs_review");
    expect(d.reasons[0]).toContain("not in the email");
  });

  test("a critical field below the confidence floor: needs review", () => {
    expect(decideFor({ guests: f(24, "24 people", 0.4) }).outcome).toBe("needs_review");
  });

  test("not an enquiry: ignored, even if the model also filled fields in", () => {
    expect(decideFor({ isEnquiry: false })).toEqual({ outcome: "ignored", reasons: ["This does not look like an enquiry"] });
  });
});

describe("edges between outcomes", () => {
  test("an unsupported optional field is flagged, it does not block the draft", () => {
    expect(decideFor({ company: f("Acme", "Acme Corp") }).outcome).toBe("flagged_draft");
  });

  test("valid dates and guests but no catalog product: still a draft, flagged to add blocks by hand", () => {
    const d = decideFor({ products: [] });
    expect(d.outcome).toBe("flagged_draft");
    expect(d.reasons[0]).toContain("add the blocks by hand");
  });

  test("the vague sample email (only a contact name): needs review", () => {
    const vague = { subject: "Event", body: "Hello, we are thinking about doing something sometime this year. Mark" };
    const d = decideFor(
      { contactName: f("Mark", "Mark"), company: f(null, null), startDate: f(null, null), endDate: f(null, null), guests: f(null, null), language: f("en", "Hello,"), products: [] },
      vague,
    );
    expect(d.outcome).toBe("needs_review");
  });

  test("reviewing an unsupported critical field still shows what the model claimed", () => {
    const v = validate(clean({ guests: f(24, "twenty four of us") }), email, catalog, TODAY, policy);
    expect(v.guests).toMatchObject({ value: null, claimed: 24 });
  });
});
