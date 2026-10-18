import { db } from "./client";

export type NewEnquiry = {
  messageId: string;
  source: "email" | "paste";
  emailId?: string;
  subject?: string;
  body?: string; // empty for email rows until the worker fetches it
  sender?: string;
};

// The one place a row enters the pipeline, for email and paste alike.
// One statement does the dedupe: a second insert with the same message_id writes nothing.
// In that case we return the id of the row that is already there.
export async function insertEnquiry(e: NewEnquiry): Promise<{ id: string; created: boolean }> {
  const sql = db();
  const [inserted] = await sql`
    INSERT INTO enquiries (message_id, source, email_id, raw_subject, raw_body, sender)
    VALUES (${e.messageId}, ${e.source}, ${e.emailId ?? null}, ${e.subject ?? null}, ${e.body ?? null}, ${e.sender ?? null})
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id`;
  if (inserted) return { id: inserted.id as string, created: true };
  const [existing] = await sql`SELECT id FROM enquiries WHERE message_id = ${e.messageId}`;
  return { id: existing.id as string, created: false };
}

// ---- Pipeline: claim and fenced writes -------------------------------------------------------------------------

export type ClaimedEnquiry = {
  id: string;
  source: "email" | "paste";
  emailId: string | null;
  subject: string | null;
  body: string | null;
  sender: string | null;
  extracted: unknown;
  attempt: number; // the fencing token: every later write must present this exact value
};

// Guarantee 2: one atomic statement decides who owns the row. Never a SELECT followed by an UPDATE.
// The winner gets the row back; everyone else gets nothing. attempts + 1 also becomes the winner's fencing token.
export async function claimEnquiry(id: string): Promise<ClaimedEnquiry | null> {
  const [row] = await db()`
    UPDATE enquiries
    SET status = 'processing',
        locked_until = now() + interval '2 minutes',
        attempts = attempts + 1,
        updated_at = now()
    WHERE id = ${id}
      AND ( status = 'queued'
            OR (status = 'retrying' AND next_attempt_at <= now())
            OR (status = 'processing' AND locked_until < now()) )
    RETURNING id, source, email_id, raw_subject, raw_body, sender, extracted, attempts`;
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    emailId: row.email_id,
    subject: row.raw_subject,
    body: row.raw_body,
    sender: row.sender,
    extracted: row.extracted,
    attempt: row.attempts,
  };
}

// Thrown when a write matches no row: the lease expired and another worker took over (or the row moved on).
// The caller stops quietly. Whatever the newer worker saves is the truth.
export class LostLeaseError extends Error {
  constructor() {
    super("lost the lease on this enquiry");
    this.name = "LostLeaseError";
  }
}

// Guarantee 3's sibling: a write only counts if this worker still owns the row, proven by the attempt number it was given.
const guard = (result: { count: number }) => {
  if (result.count === 0) throw new LostLeaseError();
};
// Each statement below spells the condition out (WHERE id AND status = 'processing' AND attempts = token) so it reads on its own.

export async function saveBody(id: string, attempt: number, body: string): Promise<void> {
  // COALESCE: the first body saved wins, the original input is never overwritten.
  guard(await db()`
    UPDATE enquiries SET raw_body = COALESCE(raw_body, ${body}), updated_at = now()
    WHERE id = ${id} AND status = 'processing' AND attempts = ${attempt}`);
}

export async function saveExtraction(id: string, attempt: number, extracted: unknown, model: string, promptVersion: string): Promise<void> {
  guard(await db()`
    UPDATE enquiries
    SET extracted = ${db().json(extracted as never)}, model = ${model}, prompt_version = ${promptVersion}, updated_at = now()
    WHERE id = ${id} AND status = 'processing' AND attempts = ${attempt}`);
}

// What the salesperson sees when there is no draft: the flags, and the plain-language reasons.
export type Report = { flags: unknown[]; reasons: string[] };

export async function finishWithoutDraft(id: string, attempt: number, status: "needs_review" | "ignored", report: Report): Promise<void> {
  guard(await db()`
    UPDATE enquiries
    SET status = ${status}, flags = ${db().json(report as never)}, locked_until = NULL, last_error = NULL, updated_at = now()
    WHERE id = ${id} AND status = 'processing' AND attempts = ${attempt}`);
}

// One statement saves the draft link and the final status together, so there is no gap between "uuid saved" and "done".
export async function finishDraft(id: string, attempt: number, draft: { uuid: string; url: string }, report: Report): Promise<void> {
  guard(await db()`
    UPDATE enquiries
    SET status = 'draft_created', proposal_uuid = ${draft.uuid}, proposal_url = ${draft.url},
        flags = ${db().json(report as never)}, locked_until = NULL, last_error = NULL, updated_at = now()
    WHERE id = ${id} AND status = 'processing' AND attempts = ${attempt}`);
}

// Retryable failure: park the row. Nothing wakes it until its time has passed and something nudges or sweeps (T15).
export async function parkRetrying(id: string, attempt: number, error: string, delaySeconds: number): Promise<void> {
  guard(await db()`
    UPDATE enquiries
    SET status = 'retrying', next_attempt_at = now() + make_interval(secs => ${delaySeconds}),
        last_error = ${error}, locked_until = NULL, updated_at = now()
    WHERE id = ${id} AND status = 'processing' AND attempts = ${attempt}`);
}

// Permanent failure: stop. The row stays, with the original email and the error, for a human to read and retry.
export async function failPermanent(id: string, attempt: number, error: string): Promise<void> {
  guard(await db()`
    UPDATE enquiries
    SET status = 'failed_permanent', last_error = ${error}, locked_until = NULL, updated_at = now()
    WHERE id = ${id} AND status = 'processing' AND attempts = ${attempt}`);
}
