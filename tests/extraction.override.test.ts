import { describe, expect, test } from "vitest";
import { overrideProblems } from "@/lib/extraction/decide";
import { parseChanges } from "@/lib/extraction/edit";
import { HAND_EVIDENCE, type Extraction } from "@/lib/extraction/schema";
import { validate } from "@/lib/extraction/validate";
import { catalog, clean, email, f, TODAY } from "./extraction.fixtures";

// A field the way a save stores it.
const hand = <T>(value: T) => f(value, HAND_EVIDENCE);
const run = (overrides: Partial<Extraction>, trusted = true) => validate(clean(overrides), email, catalog, TODAY, undefined, trusted);
const flagsFor = (v: ReturnType<typeof run>, field: string) => v.flags.filter((x) => x.field === field);

describe("validate: a human-entered value (trusted mode)", () => {
  test("is kept without an evidence quote or a confidence band", () => {
    const v = run({ guests: hand(40), startDate: hand("2027-03-10") });
    expect(v.guests.value).toBe(40);
    expect(v.startDate.value).toBe("2027-03-10");
    expect(flagsFor(v, "guests")).toEqual([]); // no "number not in the quoted words" warning either
  });

  test("the marker means nothing on a row that was not released: a model that writes it is not trusted", () => {
    const v = run({ guests: hand(40) }, false);
    expect(v.guests.value).toBeNull();
    expect(flagsFor(v, "guests")[0]).toMatchObject({ level: "unsupported" });
  });

  test("untouched model fields are still checked: a quote that is not in the email is still dropped", () => {
    const v = run({ guests: f(24, "twenty four people we invented") });
    expect(v.guests.value).toBeNull();
  });

  test.each([
    ["a date in the past", { startDate: hand("2026-01-01") }, "startDate"],
    ["a date that does not exist", { startDate: hand("2027-02-30") }, "startDate"],
    ["zero guests", { guests: hand(0) }, "guests"],
    ["more guests than the hotel holds", { guests: hand(5000) }, "guests"],
  ])("hard rule still holds for %s", (_name, overrides, field) => {
    const v = run(overrides as Partial<Extraction>);
    expect(v[field as "guests"].value).toBeNull();
  });

  test("an end date before the start drops both", () => {
    const v = run({ startDate: hand("2027-05-10"), endDate: hand("2027-05-02") });
    expect(v.startDate.value).toBeNull();
    expect(v.endDate.value).toBeNull();
  });

  test("a product that is not in the catalog is dropped even when a human typed it", () => {
    const v = run({ products: [{ variationId: 999999, confidence: 1, evidence: HAND_EVIDENCE, quantity: null, quantityEvidence: null }] });
    expect(v.products).toEqual([]);
    expect(flagsFor(v, "products").some((x) => x.level === "unsupported")).toBe(true);
  });

  test("a catalog product a human picked is kept without a quote", () => {
    const v = run({ products: [{ variationId: 3001, confidence: 1, evidence: HAND_EVIDENCE, quantity: null, quantityEvidence: null }] });
    expect(v.products.map((p) => p.variationId)).toEqual([3001]);
  });

  test("soft warnings stay as flags, they do not block", () => {
    const v = run({ startDate: hand("2026-10-20"), guests: hand(500) }); // 2 days away, large group
    expect(v.startDate.value).toBe("2026-10-20");
    expect(v.guests.value).toBe(500);
    expect(v.flags.map((x) => x.level)).toEqual(["check", "check"]);
    expect(overrideProblems(v)).toEqual([]);
  });
});

describe("overrideProblems", () => {
  test("a complete row has none", () => {
    expect(overrideProblems(run({}))).toEqual([]);
  });

  test("a missing start date or guest count blocks", () => {
    const problems = overrideProblems(run({ startDate: f(null, null, 0), guests: f(null, null, 0) }));
    expect(problems.join(" ")).toMatch(/Start date/);
    expect(problems.join(" ")).toMatch(/Guest count/);
  });

  test("a value the human typed that breaks a rule blocks, with the reason", () => {
    const problems = overrideProblems(run({ startDate: hand("2026-01-01") }));
    expect(problems.join(" ")).toMatch(/startDate: This date is in the past/);
  });

  test("a unknown product the human typed blocks", () => {
    const problems = overrideProblems(run({ products: [{ variationId: 999999, confidence: 1, evidence: HAND_EVIDENCE, quantity: null, quantityEvidence: null }] }));
    expect(problems.join(" ")).toMatch(/products/);
  });
});

describe("parseChanges", () => {
  test("turns a value into a field marked as entered by hand", () => {
    expect(parseChanges({ guests: 40 })).toEqual({ ok: true, changes: { guests: { value: 40, confidence: 1, evidence: HAND_EVIDENCE } } });
  });

  test("null clears a field to unknown", () => {
    expect(parseChanges({ guests: null })).toEqual({ ok: true, changes: { guests: { value: null, confidence: 0, evidence: null } } });
  });

  test("products are a list of ids, each marked, duplicates removed", () => {
    expect(parseChanges({ products: [3001, 3001, 3002] })).toEqual({
      ok: true,
      changes: { products: [3001, 3002].map((variationId) => ({ variationId, confidence: 1, evidence: HAND_EVIDENCE, quantity: null, quantityEvidence: null })) },
    });
  });

  test.each([
    ["not an object", "guests"],
    ["an array", [1]],
    ["empty", {}],
    ["an unknown field", { nonsense: 1 }],
    ["isEnquiry", { isEnquiry: false }],
    ["a wrong type", { guests: "forty" }],
    ["a fraction for a whole number", { guests: 4.5 }],
    ["products that are not numbers", { products: ["lunch"] }],
  ])("rejects %s", (_name, input) => {
    expect(parseChanges(input).ok).toBe(false);
  });
});
