import { db } from "./client";

// The audit trail: one row per pipeline step, so retries and failures can be read back as a timeline.
// Best effort on purpose: a failed event write is logged and never thrown, because the audit trail must not block the
// product. Outcomes are short codes ("try 2", "retry in 30s: upstream_503"), never email text.
export async function recordEvent(enquiryId: string, step: string, outcome: string): Promise<void> {
  try {
    await db()`INSERT INTO events (enquiry_id, step, outcome) VALUES (${enquiryId}, ${step}, ${outcome})`;
  } catch (err) {
    console.error("events: insert failed", { enquiryId, step, message: err instanceof Error ? err.message : String(err) });
  }
}
