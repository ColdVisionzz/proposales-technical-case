import {
  claimEnquiry,
  failPermanent,
  finishDraft,
  finishWithoutDraft,
  LostLeaseError,
  parkRetrying,
  saveBody,
  saveExtraction,
} from "../db/enquiries";
import { readableBody, truncateEmail, MAX_EMAIL_CHARS } from "../email/text";
import { decide } from "../extraction/decide";
import type { extract as extractFn } from "../extraction/extract";
import { extractionSchema } from "../extraction/schema";
import { validate, type Flag } from "../extraction/validate";
import { classifyError } from "../proposales/errors";
import type { ProposalesGateway } from "../proposales/gateway";
import { buildDraft, parseSender } from "./draft";

// Everything processEnquiry touches outside the database, passed in so tests can use fakes.
export type Deps = {
  fetchBody: (emailId: string) => Promise<{ text: string | null; html: string | null }>;
  extract: typeof extractFn;
  gateway: ProposalesGateway;
  companyId: number;
  today: () => string; // YYYY-MM-DD
};

// A retryable failure waits this long. T14 replaces the constant with backoff and an attempt limit.
export const RETRY_DELAY_SECONDS = 30;

export type Result = "not_claimed" | "lost_lease" | "ignored" | "needs_review" | "draft_created" | "retrying" | "failed_permanent";

// One function for every caller: webhook nudge, paste, retry button, sweeper.
// Each step skips itself if its result is already saved, so a crash anywhere repeats only what was not yet saved.
export async function processEnquiry(id: string, deps: Deps): Promise<Result> {
  const row = await claimEnquiry(id);
  if (!row) return "not_claimed"; // someone else owns it, or it is finished or not due yet
  const { attempt } = row;

  try {
    // 2. Body. Email rows arrive without one. Saved as the readable text, so a retry never fetches it again.
    let body = row.body;
    if (body === null) {
      if (!row.emailId) throw new Error("email row has no email_id"); // cannot happen through insertEnquiry
      body = readableBody(await deps.fetchBody(row.emailId));
      await saveBody(id, attempt, body);
    }
    if (!body.trim()) {
      const reasons = ["The email has no readable text"];
      await finishWithoutDraft(id, attempt, "needs_review", { flags: [], reasons });
      return "needs_review";
    }
    const subject = row.subject ?? "";
    const cut = truncateEmail(body);
    const email = { subject, body: cut.text, sender: row.sender ?? undefined };

    // The catalog feeds both the prompt and the validation.
    const catalog = await deps.gateway.getCatalog();
    const today = deps.today();

    // 3. Extract. Saved before any draft call, so a retry never pays for the model twice.
    const saved = extractionSchema.safeParse(row.extracted);
    let extraction = saved.success ? saved.data : null;
    if (!extraction) {
      const result = await deps.extract(email, catalog, today);
      if (result.status === "invalid") {
        const reasons = ["Could not read this reliably: the model's answer did not fit the expected shape"];
        await finishWithoutDraft(id, attempt, "needs_review", { flags: [], reasons });
        return "needs_review";
      }
      extraction = result.extraction;
      await saveExtraction(id, attempt, extraction, result.meta.model, result.meta.promptVersion);
    }

    // 4. Validate and decide. Pure and free, so recomputed on every attempt.
    const validated = validate(extraction, email, catalog, today);
    const flags: Flag[] = cut.truncated
      ? [...validated.flags, { field: "email", level: "check", message: `The email is very long: only the first ${MAX_EMAIL_CHARS} characters were read` }]
      : validated.flags;
    const decision = decide({ ...validated, flags });
    if (decision.outcome === "ignored" || decision.outcome === "needs_review") {
      await finishWithoutDraft(id, attempt, decision.outcome, { flags, reasons: decision.reasons });
      return decision.outcome;
    }

    // 5 and 6. Guarantee 1: search before create. The API has no idempotency key, so the row id is the key.
    const { email: senderEmail } = parseSender(row.sender);
    const existing = await deps.gateway.findExistingDraft(id, senderEmail);
    let draft = existing;
    let report = { flags, reasons: decision.reasons };
    if (!draft) {
      const built = buildDraft({ enquiryKey: id, companyId: deps.companyId, validated, flags, catalog, sender: row.sender });
      draft = await deps.gateway.createDraft(built.draft);
      report = { flags: [...flags, ...built.notes], reasons: decision.reasons };
    }

    // 7. One statement: draft link and final status together.
    await finishDraft(id, attempt, draft, report);
    return "draft_created";
  } catch (error) {
    if (error instanceof LostLeaseError) return "lost_lease"; // a newer worker owns the row now
    // One central classifier decides. The row records what happened, never the email's words.
    const failure = classifyError(error);
    const message = `${failure.kind}: ${failure.reason}`;
    if (failure.kind === "retryable") {
      try {
        await parkRetrying(id, attempt, message, RETRY_DELAY_SECONDS);
      } catch (parkError) {
        if (parkError instanceof LostLeaseError) return "lost_lease";
        throw parkError;
      }
      return "retrying";
    }
    try {
      await failPermanent(id, attempt, message);
    } catch (failError) {
      if (failError instanceof LostLeaseError) return "lost_lease";
      throw failError;
    }
    return "failed_permanent";
  }
}
