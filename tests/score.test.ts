import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { score } from "@/lib/extraction/score";
import type { Validated } from "@/lib/extraction/validate";

const checked = <T>(value: T | null) => ({ value, claimed: value, confidence: 1, evidence: null });
const v = {
  isEnquiry: true,
  startDate: checked("2027-03-12"),
  endDate: checked(null),
  guests: checked(24),
  language: checked("en"),
  products: [{ variationId: 3002 }, { variationId: 3001 }],
} as unknown as Validated;

describe("score", () => {
  test("a matching field passes, a wrong one fails with expected and got", () => {
    const s = score({ guests: 24, startDate: "2027-03-13", outcome: "draft" }, v, "draft");
    expect(s.guests?.pass).toBe(true);
    expect(s.outcome?.pass).toBe(true);
    expect(s.startDate).toEqual({ pass: false, expected: "2027-03-13", got: "2027-03-12" });
  });

  test("fields not in expect are not scored; an expected null must be null", () => {
    const s = score({ endDate: null, products: [3001, 3002] }, v, "draft");
    expect(Object.keys(s).sort()).toEqual(["endDate", "products"]);
    expect(s.endDate?.pass && s.products?.pass).toBe(true);
    expect(score({ guests: null }, v, "draft").guests?.pass).toBe(false);
  });

  test("invalid model output fails every expected field", () => {
    const s = score({ guests: 24, outcome: "draft" }, null, "invalid");
    expect(s.guests?.pass).toBe(false);
    expect(s.outcome?.pass).toBe(false);
  });
});

describe("eval fixtures", () => {
  test("every fixture has an expect with an outcome", () => {
    const dir = join(__dirname, "..", "fixtures", "enquiries");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const f of files) expect(JSON.parse(readFileSync(join(dir, f), "utf8")).expect?.outcome, f).toBeTruthy();
  });
});
