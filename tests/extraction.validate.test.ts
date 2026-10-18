import { describe, expect, test } from "vitest";
import { policy } from "@/lib/extraction/policy";
import type { Extraction } from "@/lib/extraction/schema";
import { normalise, validate } from "@/lib/extraction/validate";
import { catalog, clean, email, f, TODAY } from "./extraction.fixtures";

const run = (overrides: Partial<Extraction> = {}, em = email, limits = policy) => validate(clean(overrides), em, catalog, TODAY, limits);
const flagsFor = (v: ReturnType<typeof run>, field: string) => v.flags.filter((x) => x.field === field);

describe("a clean enquiry", () => {
  test("keeps every value and raises no flag", () => {
    const v = run();
    expect(v.flags).toEqual([]);
    expect(v.startDate.value).toBe("2027-03-12");
    expect(v.guests.value).toBe(24);
    expect(v.language.value).toBe("en");
    expect(v.products.map((p) => p.variationId)).toEqual([3001, 3002]);
  });

  test("a field the email does not state is simply empty, with no flag", () => {
    const v = run();
    expect(v.budget.value).toBeNull();
    expect(flagsFor(v, "budget")).toEqual([]);
  });

  test("not an enquiry: nothing is carried over and nothing is flagged", () => {
    const v = run({ isEnquiry: false });
    expect(v.isEnquiry).toBe(false);
    expect(v.guests.value).toBeNull();
    expect(v.flags).toEqual([]);
  });
});

describe("evidence quotes", () => {
  test("spacing, case, curly quotes and dash style may differ, the words may not", () => {
    const em = { subject: "x", body: "We’d like   12–13 March 2027\nfor 24 people" };
    const v = run({ startDate: f("2027-03-12", "12-13 march 2027"), guests: f(24, "24  PEOPLE") }, em);
    expect(v.startDate.value).toBe("2027-03-12");
    expect(v.guests.value).toBe(24);
    expect(normalise("We’d\tlike—it")).toBe("we'd like-it");
  });

  test("a quote that is not in the email makes the field unsupported: value dropped, claim kept, flag raised", () => {
    const v = run({ guests: f(24, "twenty four of us") });
    expect(v.guests.value).toBeNull();
    expect(v.guests.claimed).toBe(24);
    expect(flagsFor(v, "guests")).toMatchObject([{ level: "unsupported", claimed: 24, evidence: "twenty four of us" }]);
  });

  test.each([null, "", "   "])("a value with no usable quote (%j) is unsupported", (evidence) => {
    expect(run({ company: f("Northwind AB", evidence) }).company.value).toBeNull();
  });

  test("the quote must be in the email text, not just the model's own words", () => {
    expect(run({ budget: f("50000 kr", "budget of 50000 kr") }).budget.value).toBeNull();
  });
});

describe("dates", () => {
  test.each(["12 March 2027", "2027-02-30", "2027-13-01", "27-03-12", "not a date"])("%s is not a real YYYY-MM-DD date", (date) => {
    const v = run({ startDate: f(date, "12-13 March 2027") });
    expect(v.startDate.value).toBeNull();
    expect(flagsFor(v, "startDate")[0]).toMatchObject({ level: "unsupported" });
  });

  test("a date in the past is unsupported", () => {
    expect(run({ startDate: f("2026-10-17", "12-13 March 2027"), endDate: f(null, null) }).startDate.value).toBeNull();
  });

  test.each([
    ["2026-10-18", true], // today
    ["2026-10-25", true], // exactly 7 days
    ["2026-10-26", false], // 8 days
  ])("start %s: short notice flag = %s, and the date is kept", (date, flagged) => {
    const v = run({ startDate: f(date, "12-13 March 2027"), endDate: f(null, null) });
    expect(v.startDate.value).toBe(date);
    expect(flagsFor(v, "startDate").some((x) => x.message.startsWith("Short notice"))).toBe(flagged);
  });

  test("an end date before the start date drops both and says why", () => {
    const v = run({ endDate: f("2027-03-11", "12-13 March 2027") });
    expect(v.startDate.value).toBeNull();
    expect(v.endDate.value).toBeNull();
    expect(v.startDate.claimed).toBe("2027-03-12");
    expect(flagsFor(v, "startDate")[0].message).toContain("Conflicting dates");
    expect(flagsFor(v, "endDate")[0].message).toContain("Conflicting dates");
  });

  test("a single-day event (end equals start) is fine", () => {
    expect(run({ endDate: f("2027-03-12", "12-13 March 2027") }).flags).toEqual([]);
  });
});

describe("guest count", () => {
  test.each([0, -3, 2.5, 1001])("%s is unsupported", (n) => {
    const v = run({ guests: f(n, "24 people") });
    expect(v.guests.value).toBeNull();
    expect(flagsFor(v, "guests")[0]).toMatchObject({ level: "unsupported" });
  });

  test.each([
    [200, false],
    [201, true],
    [1000, true],
  ])("%i guests: very-large-group flag = %s", (n, flagged) => {
    const v = run({ guests: f(n, `${n} people`) }, { subject: "x", body: `${n} people` });
    expect(v.guests.value).toBe(n);
    expect(flagsFor(v, "guests").some((x) => x.message.startsWith("Very large group"))).toBe(flagged);
  });

  test("a real quote that does not contain the claimed number is flagged, not trusted silently", () => {
    const v = run({ guests: f(50, "24 people") });
    expect(v.guests.value).toBe(50);
    expect(flagsFor(v, "guests")).toMatchObject([{ level: "check", message: expect.stringContaining("digits") }]);
  });

  test("1 000 and 1,000 in the quote both count as 1000", () => {
    for (const written of ["1 000 people", "1,000 people"]) {
      const v = run({ guests: f(1000, written) }, { subject: "x", body: written });
      expect(flagsFor(v, "guests").some((x) => x.message.includes("digits"))).toBe(false);
    }
  });
});

describe("confidence bands", () => {
  test.each([
    [1, 0],
    [0.8, 0],
    [0.79, 1],
    [0.6, 1],
  ])("an optional field at %s: %i check flag(s), value kept", (confidence, flags) => {
    const v = run({ company: f("Northwind AB", "Northwind AB", confidence) });
    expect(v.company.value).toBe("Northwind AB");
    expect(flagsFor(v, "company")).toHaveLength(flags);
  });

  test("an optional field below 0.6 is kept but flagged as low confidence", () => {
    const v = run({ company: f("Northwind AB", "Northwind AB", 0.59) });
    expect(v.company.value).toBe("Northwind AB");
    expect(flagsFor(v, "company")).toMatchObject([{ level: "check", message: expect.stringContaining("Low confidence") }]);
  });

  test.each([
    [0.8, "kept"],
    [0.6, "kept"],
    [0.59, "dropped"],
  ])("a critical field at %s is %s", (confidence, result) => {
    const v = run({ guests: f(24, "24 people", confidence) });
    expect(v.guests.value).toBe(result === "kept" ? 24 : null);
  });

  test.each([Number.NaN, -1])("a nonsense confidence (%s) counts as zero", (confidence) => {
    expect(run({ guests: f(24, "24 people", confidence) }).guests.value).toBeNull();
  });

  test("a confidence above 1 counts as 1", () => {
    expect(run({ guests: f(24, "24 people", 7) }).flags).toEqual([]);
  });

  test("the bands come from the policy, so a different model can use different ones", () => {
    const strict = { ...policy, certain: 0.95, examine: 0.9 };
    expect(flagsFor(run({ company: f("Northwind AB", "Northwind AB", 0.92) }, email, strict), "company")).toHaveLength(1);
    expect(run({ guests: f(24, "24 people", 0.85) }, email, strict).guests.value).toBeNull();
  });
});

describe("products", () => {
  const productFlags = (v: ReturnType<typeof run>) => flagsFor(v, "products");

  test("an id that is not in the catalog is dropped and flagged, never passed on", () => {
    const v = run({ products: [{ variationId: 9999, confidence: 1, evidence: "a meeting room" }, { variationId: 3001, confidence: 1, evidence: "a meeting room" }] });
    expect(v.products.map((p) => p.variationId)).toEqual([3001]);
    expect(productFlags(v)).toMatchObject([{ level: "unsupported", claimed: 9999 }]);
  });

  test("a product whose quote is not in the email is dropped", () => {
    const v = run({ products: [{ variationId: 3004, confidence: 1, evidence: "dinner for everyone" }, { variationId: 3001, confidence: 1, evidence: "a meeting room" }] });
    expect(v.products.map((p) => p.variationId)).toEqual([3001]);
  });

  test("a product the model was unsure about is dropped below 0.6 and flagged between 0.6 and 0.8", () => {
    const v = run({ products: [{ variationId: 3001, confidence: 0.59, evidence: "a meeting room" }, { variationId: 3002, confidence: 0.7, evidence: "lunch" }] });
    expect(v.products.map((p) => p.variationId)).toEqual([3002]);
    expect(productFlags(v).map((x) => x.level).sort()).toEqual(["check", "unsupported"]);
  });

  test("product flags name the product so a salesperson can read them", () => {
    const v = run({ products: [{ variationId: 3002, confidence: 0.7, evidence: "lunch" }] });
    expect(productFlags(v)[0].message).toBe('"Lunch": the model was only fairly sure (0.7)');
  });

  test("the same product twice is kept once", () => {
    const one = { variationId: 3001, confidence: 1, evidence: "a meeting room" };
    expect(run({ products: [one, one] }).products).toHaveLength(1);
  });

  test("no usable product leaves a flag telling the salesperson to add blocks by hand", () => {
    const v = run({ products: [] });
    expect(v.products).toEqual([]);
    expect(productFlags(v)).toMatchObject([{ level: "check", message: expect.stringContaining("add the blocks by hand") }]);
  });
});

describe("language", () => {
  test("is lower-cased", () => expect(run({ language: f("SV", "Hi, we are 24 people") }).language.value).toBe("sv"));

  test.each(["English", "e", "en-GB"])("%s is not a two-letter code: unsupported, with the default-language flag", (code) => {
    const v = run({ language: f(code, "Hi, we are 24 people") });
    expect(v.language.value).toBeNull();
    expect(flagsFor(v, "language").map((x) => x.level)).toEqual(["unsupported", "check"]);
  });

  test("unknown language raises the default-language flag", () => {
    expect(flagsFor(run({ language: f(null, null) }), "language")).toMatchObject([{ level: "check", message: expect.stringContaining("English") }]);
  });
});

describe("rooms and nights", () => {
  test("rooms must be a whole number of at least 1", () => {
    expect(run({ rooms: f(0, "24 people") }).rooms.value).toBeNull();
    expect(run({ rooms: f(2.5, "24 people") }).rooms.value).toBeNull();
    expect(run({ rooms: f(12, "24 people") }).rooms.value).toBe(12);
  });

  // The real model returned nights: 0 for a one-day meeting, and a first version of the rule rejected it.
  test.each([0, 1, 2])("%i nights is fine", (n) => {
    expect(run({ nights: f(n, "12-13 March 2027") }).nights.value).toBe(n);
  });

  test.each([-1, 1.5])("%s nights is unsupported", (n) => {
    expect(run({ nights: f(n, "12-13 March 2027") }).nights.value).toBeNull();
  });
});

test("a malformed today is a programming error, not a silent pass", () => {
  expect(() => validate(clean(), email, catalog, "18/10/2026")).toThrow("YYYY-MM-DD");
});
