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
