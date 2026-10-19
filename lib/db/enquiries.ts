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
  attempt: number; // the fencing token: every later write must present this exact value. Never resets.
  tries: number; // claims since the last manual reset, this one included: what the attempt cap reads
  dedupeCleared: boolean; // this row already won the right to create a draft, so the fingerprint step is skipped
};

// Guarantee 2: one atomic statement decides who owns the row. Never a SELECT followed by an UPDATE.
// The winner gets the row back; everyone else gets nothing. attempts + 1 also becomes the winner's fencing token.
// tries + 1 is what the cap counts. It goes up here, not in a catch block, because a crash runs no code: a row that
// crashes every time reaches maxTries, stops being claimable, and waits for the sweeper to fail it.
export async function claimEnquiry(id: string, maxTries: number): Promise<ClaimedEnquiry | null> {
  const [row] = await db()`
    UPDATE enquiries
    SET status = 'processing',
        locked_until = now() + interval '2 minutes',
        attempts = attempts + 1,
        tries = tries + 1,
        updated_at = now()
    WHERE id = ${id}
      AND tries < ${maxTries}
      AND ( status = 'queued'
            OR (status = 'retrying' AND next_attempt_at <= now())
            OR (status = 'processing' AND locked_until < now()) )
    RETURNING id, source, email_id, raw_subject, raw_body, sender, extracted, attempts, tries, dedupe_cleared`;
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
    tries: row.tries,
    dedupeCleared: row.dedupe_cleared,
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

export type FingerprintDecision =
  | { decision: "proceed" } // nobody else owns this content: go on and create (this row is now marked cleared)
  | { decision: "wait" } // an earlier row with the same content is still being processed: try again later
  | { decision: "adopt"; of: string; draft: { uuid: string; url: string } }; // an earlier row already made the draft

// Guarantee 1, layer 3: the same text sent again must not make a second draft. Two rows with the same content can reach
// this point at the same moment, so a plain "look, then decide" would let both through. The advisory lock on the
// fingerprint makes the look-and-decide one step at a time, and the decision is written before the lock is released
// (the lock ends with the transaction), so the next row sees it. A row marked cleared is the one owner of the creation.
// The write is fenced like every other: a worker that lost its lease throws and nothing is saved.
export async function registerFingerprint(id: string, attempt: number, fingerprint: string, windowDays: number): Promise<FingerprintDecision> {
  return db().begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${fingerprint}, 0))`;
    const [done] = await tx`
      SELECT id, proposal_uuid, proposal_url FROM enquiries
      WHERE fingerprint = ${fingerprint} AND id <> ${id} AND proposal_uuid IS NOT NULL
        AND created_at > now() - make_interval(days => ${windowDays})
      ORDER BY created_at, id LIMIT 1`;
    let result: FingerprintDecision;
    if (done) {
      result = { decision: "adopt", of: done.id, draft: { uuid: done.proposal_uuid, url: done.proposal_url } };
    } else {
      const [owner] = await tx`
        SELECT 1 FROM enquiries
        WHERE fingerprint = ${fingerprint} AND id <> ${id} AND dedupe_cleared AND status IN ('queued', 'processing', 'retrying')
          AND created_at > now() - make_interval(days => ${windowDays})
        LIMIT 1`;
      result = owner ? { decision: "wait" } : { decision: "proceed" };
    }
    guard(await tx`
      UPDATE enquiries
      SET fingerprint = ${fingerprint}, duplicate_of = ${result.decision === "adopt" ? result.of : null},
          dedupe_cleared = ${result.decision === "proceed"}, updated_at = now()
      WHERE id = ${id} AND status = 'processing' AND attempts = ${attempt}`);
    return result;
  });
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

// Manual retry: a human re-queues a row that gave up. One statement, and only from failed_permanent, so a second press
// or a press on a healthy row changes nothing. Resets the try count, never the ticket: `attempts` is left alone so a
// ticket number is never handed out twice and a stalled old worker still cannot write (T12 finding 1).
export async function retryEnquiry(id: string): Promise<{ ok: true } | { ok: false; status: string | null }> {
  const sql = db();
  const [updated] = await sql`
    UPDATE enquiries
    SET status = 'queued', tries = 0, next_attempt_at = NULL, last_error = NULL, locked_until = NULL, updated_at = now()
    WHERE id = ${id} AND status = 'failed_permanent'
    RETURNING id`;
  if (updated) return { ok: true };
  const [current] = await sql`SELECT status FROM enquiries WHERE id = ${id}`;
  return { ok: false, status: current ? current.status : null };
}

// ---- Guarantee 3: human edits ---------------------------------------------------------------------------------------

export type CurrentEnquiry = { status: string; version: number; extracted: unknown };

// Optimistic locking: the edit says "change this, assuming it is still version N". One statement checks and changes.
// The status check sits in the same statement, so a human edit can never race a running worker: only needs_review rows
// are editable, and no worker touches those.
// Zero rows: the version is stale, the row is not editable now, or the id does not exist. The caller gets the current row.
export async function editExtraction(
  id: string,
  extracted: unknown,
  version: number,
): Promise<{ ok: true; version: number } | { ok: false; current: CurrentEnquiry | null }> {
  const sql = db();
  const [updated] = await sql`
    UPDATE enquiries
    SET extracted = ${sql.json(extracted as never)}, version = version + 1, updated_at = now()
    WHERE id = ${id} AND version = ${version} AND status = 'needs_review'
    RETURNING version`;
  if (updated) return { ok: true, version: updated.version };
  const [current] = await sql`SELECT status, version, extracted FROM enquiries WHERE id = ${id}`;
  return { ok: false, current: current ? { status: current.status, version: current.version, extracted: current.extracted } : null };
}
