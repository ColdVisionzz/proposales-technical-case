import {
  claimEnquiry,
  failPermanent,
  finishDraft,
  finishWithoutDraft,
  LostLeaseError,
  parkRetrying,
  registerFingerprint,
  saveBody,
  saveExtraction,
} from "../db/enquiries";
import { readableBody, truncateEmail, MAX_EMAIL_CHARS } from "../email/text";
import { decide } from "../extraction/decide";
import type { extract as extractFn } from "../extraction/extract";
import { extractionSchema } from "../extraction/schema";
import { validate, type Flag } from "../extraction/validate";
import { classifyError, GatewayError } from "../proposales/errors";
import type { ProposalesGateway } from "../proposales/gateway";
import { buildDraft, parseSender } from "./draft";
import { DUPLICATE_WINDOW_DAYS, fingerprintOf } from "./fingerprint";
import { exhausted, MAX_TRIES, retryDelaySeconds } from "./retry";

// Everything processEnquiry touches outside the database, passed in so tests can use fakes.
export type Deps = {
  fetchBody: (emailId: string) => Promise<{ text: string | null; html: string | null }>;
  extract: typeof extractFn;
  gateway: ProposalesGateway;
  companyId: number;
  today: () => string; // YYYY-MM-DD
  schedule: (id: string, delaySeconds: number) => Promise<void>; // wake a parked row after its backoff (never throws)
};

export type Result = "not_claimed" | "lost_lease" | "ignored" | "needs_review" | "draft_created" | "retrying" | "failed_permanent";

// One function for every caller: webhook nudge, paste, retry button, sweeper.
// Each step skips itself if its result is already saved, so a crash anywhere repeats only what was not yet saved.
export async function processEnquiry(id: string, deps: Deps): Promise<Result> {
  const row = await claimEnquiry(id, MAX_TRIES);
  if (!row) return "not_claimed"; // someone else owns it, or it is finished, not due yet, or out of tries
  const { attempt, tries } = row;
  let step: "model" | "other" = "other"; // which cap applies if this try fails: model errors cost money, so they give up sooner

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
    // 2b. Guarantee 1, layer 3: the same text sent again has a new Message-ID, so only its content can show it is a repeat.
    // Before the model runs, so a repeat costs nothing. A row that already won the right to create (cleared) skips this.
    if (!row.dedupeCleared) {
      const fingerprint = fingerprintOf(row.sender, body);
      if (fingerprint) {
        const seen = await registerFingerprint(id, attempt, fingerprint, DUPLICATE_WINDOW_DAYS);
        // Retryable, so the normal backoff and cap apply. Not really a gateway failure, but it is the type the catch classifies.
        if (seen.decision === "wait") throw new GatewayError({ kind: "retryable", reason: "duplicate_in_flight" });
        if (seen.decision === "adopt") {
          const reasons = [`Same email as an earlier enquiry (${seen.of.slice(0, 8)}): its draft was reused, no new draft was created`];
          await finishDraft(id, attempt, seen.draft, { flags: [], reasons });
          return "draft_created";
        }
      }
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
      step = "model";
      const result = await deps.extract(email, catalog, today);
      step = "other";
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
    const giveUp = failure.kind === "retryable" && exhausted(tries, step);
    if (failure.kind === "retryable" && !giveUp) {
      const delay = retryDelaySeconds(tries, failure.retryAfterMs);
      try {
        await parkRetrying(id, attempt, message, delay);
      } catch (parkError) {
        if (parkError instanceof LostLeaseError) return "lost_lease";
        throw parkError;
      }
      // Park first, then schedule: the saved row is the truth, the message only wakes it. If the send is lost, the sweeper recovers.
      await deps.schedule(id, delay);
      return "retrying";
    }
    try {
      await failPermanent(id, attempt, giveUp ? `gave up after ${tries} tries: ${message}` : message);
    } catch (failError) {
      if (failError instanceof LostLeaseError) return "lost_lease";
      throw failError;
    }
    return "failed_permanent";
  }
}
