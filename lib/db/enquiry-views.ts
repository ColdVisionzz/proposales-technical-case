import { db } from "./client";
import { maskDeep, maskEmails } from "./mask";

const mask = (s: string | null) => (s === null ? null : maskEmails(s));

// Read-only queries for the dashboard. Plain SELECTs: nothing here changes state, so none of it can race the pipeline.

// Visitors only see a row touched in the last 15 minutes, or one still moving (so a parked retry never vanishes). Both
// queries apply it in SQL, so a guessed id cannot reach a row the list hides.
const visible = (sql: ReturnType<typeof db>) => sql`(updated_at > now() - interval '15 minutes' OR status IN ('queued', 'processing', 'retrying'))`;

// What a row in the list needs. No email body and no extracted fields: the list is fetched every 2 s, so it stays light
// and never carries customer text beyond sender and subject. Every string that leaves here has its email addresses masked.
export type EnquirySummary = {
  id: string;
  status: string;
  source: "email" | "paste";
  sender: string | null;
  subject: string | null;
  createdAt: string;
  updatedAt: string;
  proposalUrl: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  tries: number;
  step: string | null; // latest pipeline event: tells "reading the mail" from "creating the draft" while status is processing
};

export const LIST_LIMIT = 50;

export async function listEnquiries(limit = LIST_LIMIT): Promise<EnquirySummary[]> {
  const sql = db();
  const rows = await sql`
    SELECT e.id, e.status, e.source, e.sender, e.raw_subject, e.created_at, e.updated_at, e.proposal_url, e.last_error,
           e.next_attempt_at, e.tries, last.step
    FROM (SELECT * FROM enquiries WHERE ${visible(sql)}) e
    LEFT JOIN LATERAL (
      SELECT step FROM events WHERE enquiry_id = e.id ORDER BY created_at DESC, id DESC LIMIT 1
    ) last ON true
    ORDER BY e.created_at DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    source: r.source,
    sender: mask(r.sender),
    subject: mask(r.raw_subject),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    proposalUrl: r.proposal_url,
    lastError: mask(r.last_error),
    nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : null,
    tries: r.tries,
    step: r.step,
  }));
}

export type TimelineEvent = { step: string; outcome: string; at: string };

export type EnquiryDetail = EnquirySummary & {
  body: string | null;
  extracted: unknown;
  flags: unknown;
  version: number;
  model: string | null;
  events: TimelineEvent[];
};

export async function getEnquiryDetail(id: string): Promise<EnquiryDetail | null> {
  const sql = db();
  const [r] = await sql`
    SELECT id, status, source, sender, raw_subject, raw_body, created_at, updated_at, proposal_url, last_error,
           next_attempt_at, tries, extracted, flags, version, model
    FROM enquiries WHERE id = ${id} AND ${visible(sql)}`;
  if (!r) return null;
  const events = await sql`SELECT step, outcome, created_at FROM events WHERE enquiry_id = ${id} ORDER BY created_at, id`;
  const timeline = events.map((e) => ({ step: e.step as string, outcome: maskEmails(e.outcome as string), at: new Date(e.created_at).toISOString() }));
  return {
    id: r.id,
    status: r.status,
    source: r.source,
    sender: mask(r.sender),
    subject: mask(r.raw_subject),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    proposalUrl: r.proposal_url,
    lastError: mask(r.last_error),
    nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : null,
    tries: r.tries,
    step: timeline.at(-1)?.step ?? null,
    body: mask(r.raw_body),
    extracted: maskDeep(r.extracted),
    flags: maskDeep(r.flags),
    version: r.version,
    model: r.model,
    events: timeline,
  };
}
