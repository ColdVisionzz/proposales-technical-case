import type { Validated } from "./validate";

export type Outcome = "ignored" | "needs_review" | "flagged_draft" | "draft";
export type Decision = { outcome: Outcome; reasons: string[] };

// A draft is worth creating only when these two are trusted.
const CRITICAL = [
  ["startDate", "Start date"],
  ["guests", "Guest count"],
] as const;

// First match wins: not an enquiry, then a critical field missing, then any flag, then a clean draft.
export function decide(v: Validated): Decision {
  if (!v.isEnquiry) return { outcome: "ignored", reasons: ["This does not look like an enquiry"] };

  const missing = CRITICAL.filter(([key]) => v[key].value === null).map(([key, label]) => {
    const why = v.flags.filter((f) => f.field === key && f.level === "unsupported").map((f) => f.message);
    return `${label}: ${why.length ? why.join("; ") : "not found in the email"}`;
  });
  if (missing.length) return { outcome: "needs_review", reasons: missing };

  if (v.flags.length) return { outcome: "flagged_draft", reasons: v.flags.map((f) => `${f.field}: ${f.message}`) };
  return { outcome: "draft", reasons: [] };
}
