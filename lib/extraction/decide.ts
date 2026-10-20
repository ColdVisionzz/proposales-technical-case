import { draftLevelFields } from "./policy";
import { HAND_EVIDENCE } from "./schema";
import type { Flag, Validated } from "./validate";

export type Outcome = "ignored" | "needs_review" | "flagged_draft" | "draft";
export type Decision = { outcome: Outcome; reasons: string[] };

// A draft is worth creating only when these two are trusted.
const CRITICAL = [
  ["startDate", "Start date"],
  ["guests", "Guest count"],
] as const;

export const isDraftLevel = (flag: Flag) => draftLevelFields.includes(flag.field);

// First match wins: not an enquiry, then a critical field missing, then a draft-level flag, then a clean draft.
// Flags on other fields are kept in the report and shown next to their field, but do not flag the draft.
export function decide(v: Validated): Decision {
  if (!v.isEnquiry) return { outcome: "ignored", reasons: ["This does not look like an enquiry"] };

  const missing = CRITICAL.filter(([key]) => v[key].value === null).map(([key, label]) => {
    const why = v.flags.filter((f) => f.field === key && f.level === "unsupported").map((f) => f.message);
    return `${label}: ${why.length ? why.join("; ") : "not found in the email"}`;
  });
  if (missing.length) return { outcome: "needs_review", reasons: missing };

  const important = v.flags.filter(isDraftLevel);
  if (important.length) return { outcome: "flagged_draft", reasons: important.map((f) => `${f.field}: ${f.message}`) };
  return { outcome: "draft", reasons: [] };
}

// Under "create draft anyway" the outcome decision is skipped, but a draft still needs the two critical fields, and a
// value the human typed must not break a hard rule (a past date, an unknown product). Returns what blocks the draft.
export function overrideProblems(v: Validated): string[] {
  const d = decide(v);
  const missing = d.outcome === "needs_review" ? d.reasons : [];
  const typed = v.flags.filter((f) => f.level === "unsupported" && f.evidence === HAND_EVIDENCE).map((f) => `${f.field}: ${f.message}`);
  return [...new Set([...missing, ...typed])];
}
