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
import { decide, overrideProblems } from "../extraction/decide";
import type { extract as extractFn } from "../extraction/extract";
import { extractionSchema } from "../extraction/schema";
import { validate, type Flag } from "../extraction/validate";
import { classifyError, GatewayError } from "../proposales/errors";
import type { ProposalesGateway } from "../proposales/gateway";
import { buildDraft, parseSender } from "./draft";
import { DUPLICATE_WINDOW_DAYS, fingerprintOf } from "./fingerprint";
import { recordEvent } from "../db/events";
import { SimulatedCrash, type Faults } from "./faults";
import { exhausted, MAX_TRIES, retryDelaySeconds, WATCHDOG_SECONDS } from "./retry";

// Everything processEnquiry touches outside the database, passed in so tests can use fakes.
export type Deps = {
  faults?: Faults; // fault injection for tests; productionDeps() never sets it
  fetchBody: (emailId: string) => Promise<{ text: string | null; html: string | null }>;
  extract: typeof extractFn;
  gateway: ProposalesGateway;
  companyId: number;
  today: () => string; // YYYY-MM-DD
  schedule: (id: string, delaySeconds: number) => Promise<void>; // delayed wake-up: the watchdog after a claim, the retry after a park (never throws)
};

export type Result = "not_claimed" | "lost_lease" | "ignored" | "needs_review" | "draft_created" | "retrying" | "failed_permanent";

// One function for every caller: webhook nudge, paste, retry button, sweeper.
// Each step skips itself if its result is already saved, so a crash anywhere repeats only what was not yet saved.
export async function processEnquiry(id: string, deps: Deps): Promise<Result> {
  const row = await claimEnquiry(id, MAX_TRIES);
  if (!row) return "not_claimed"; // someone else owns it, or it is finished, not due yet, or out of tries
  const { attempt, tries } = row;
  // The watchdog: if this worker dies, it cannot ask for its own retry, so ask now for a wake-up just after the lease.
  // A worker that finishes or parks the row makes the message harmless: the claim refuses it. Never throws.
  await deps.schedule(id, WATCHDOG_SECONDS);
  // The timeline the dashboard shows: one event as each step finishes (best effort, never fails the enquiry).
  const log = (eventStep: string, outcome: string) => recordEvent(id, eventStep, outcome);
  await log("claimed", `try ${tries}`);
  let step: "model" | "other" = "other"; // which cap applies if this try fails: model errors cost money, so they give up sooner

  try {
    // 2. Body. Email rows arrive without one. Saved as the readable text, so a retry never fetches it again.
    let body = row.body;
    if (body === null) {
      if (!row.emailId) throw new Error("email row has no email_id"); // cannot happen through insertEnquiry
      body = readableBody(await deps.fetchBody(row.emailId));
      await saveBody(id, attempt, body);
      await log("body_fetched", "ok");
    }
    // A released row with no readable text is fine: the human filled in the fields. (fingerprintOf gives null for an empty body.)
    if (!body.trim() && !row.override) {
      const reasons = ["The email has no readable text"];
      await finishWithoutDraft(id, attempt, "needs_review", { flags: [], reasons });
      await log("done", "needs_review: no readable text");
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
          await log("draft_found", `same email as ${seen.of.slice(0, 8)}, its draft was reused`);
          await log("done", "draft_created");
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
        await log("extracted", "invalid output");
        await log("done", "needs_review");
        return "needs_review";
      }
      extraction = result.extraction;
      await saveExtraction(id, attempt, extraction, result.meta.model, result.meta.promptVersion);
      await log("extracted", result.meta.model);
    }

    // 4. Validate and decide. Pure and free, so recomputed on every attempt.
    // A row released with "create draft anyway" skips the outcome decision: a human vouched for it. What they typed is
    // trusted for evidence and confidence only; the hard rules and the two critical fields still have to hold.
    const validated = validate(extraction, email, catalog, today, undefined, row.override);
    const flags: Flag[] = cut.truncated
      ? [...validated.flags, { field: "email", level: "check", message: `The email is very long: only the first ${MAX_EMAIL_CHARS} characters were read` }]
      : validated.flags;
    let decision = decide({ ...validated, flags });
    if (row.override) {
      const problems = overrideProblems({ ...validated, flags });
      decision = problems.length ? { outcome: "needs_review", reasons: problems } : { outcome: "flagged_draft", reasons: [] };
    }
    await log("decided", row.override ? `${decision.outcome} (override)` : decision.outcome);
    if (decision.outcome === "ignored" || decision.outcome === "needs_review") {
      await finishWithoutDraft(id, attempt, decision.outcome, { flags, reasons: decision.reasons });
      await log("done", decision.outcome);
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
      // Written before the crash hook and before the save: this is the moment Proposales and our row disagree.
      await log("draft_created", "at Proposales");
      await deps.faults?.afterCreate?.(); // tests only: the draft exists at Proposales, our row does not know yet
      report = { flags: [...flags, ...built.notes], reasons: decision.reasons };
    } else {
      await log("draft_found", "already at Proposales, none created");
    }

    // 7. One statement: draft link and final status together.
    await finishDraft(id, attempt, draft, report);
    await log("done", "draft_created");
    return "draft_created";
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error; // a real crash runs no code: leave the row exactly as it is
    if (error instanceof LostLeaseError) return "lost_lease"; // a newer worker owns the row now
    // One central classifier decides. The row records what happened, never the email's words.
    const failure = classifyError(error);
    const message = `${failure.kind}: ${failure.reason}${failure.kind === "permanent" && failure.detail ? ` (${failure.detail})` : ""}`;
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
      await log("retry_scheduled", `${message}, in ${Math.round(delay)}s`);
      return "retrying";
    }
    const finalMessage = giveUp ? `gave up after ${tries} tries: ${message}` : message;
    try {
      await failPermanent(id, attempt, finalMessage);
    } catch (failError) {
      if (failError instanceof LostLeaseError) return "lost_lease";
      throw failError;
    }
    await log("failed", finalMessage);
    return "failed_permanent";
  }
}
