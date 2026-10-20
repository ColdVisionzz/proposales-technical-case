import type { Outcome } from "./decide";
import type { Validated } from "./validate";

// The fields the eval scores. A fixture's `expect` lists only the ones it cares about; the rest are not scored.
export const FIELDS = ["startDate", "endDate", "guests", "products", "language", "outcome"] as const;
export type Field = (typeof FIELDS)[number];
export type Expect = Partial<{
  startDate: string | null;
  endDate: string | null;
  guests: number | null;
  language: string | null;
  products: number[];
  outcome: Outcome;
}>;
export type FieldScore = { pass: boolean; expected: unknown; got: unknown };

// Compares what code trusts after validate() and decide() with the expectation, field by field. Exact match, no tolerance.
// `v` is null when the model returned invalid output: every expected field then fails.
export function score(expect: Expect, v: Validated | null, outcome: Outcome | "invalid"): Partial<Record<Field, FieldScore>> {
  const got: Record<Field, unknown> = {
    startDate: v?.startDate.value,
    endDate: v?.endDate.value,
    guests: v?.guests.value,
    language: v?.language.value,
    products: v?.products.map((p) => p.variationId).sort((a, b) => a - b),
    outcome,
  };
  const result: Partial<Record<Field, FieldScore>> = {};
  for (const field of FIELDS) {
    if (!(field in expect)) continue;
    const expected = field === "products" ? [...(expect.products as number[])].sort((a, b) => a - b) : expect[field];
    result[field] = { pass: JSON.stringify(got[field]) === JSON.stringify(expected), expected, got: got[field] };
  }
  return result;
}
