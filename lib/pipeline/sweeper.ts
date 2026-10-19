import { db } from "../db/client";
import { nudge } from "../queue";
import { MAX_TRIES } from "./retry";

// Rows woken per sweep. After an outage a backlog must not hit Proposales and the model all at once.
export const SWEEP_BATCH = 10;

// The safety net: finds rows nothing will wake on its own and nudges them. Safe to run twice, or at the same moment as
// another sweep: the SELECT below is not a claim, the worker's atomic claim still decides who runs a row.
// Retries wake through delayed queue messages (lib/queue.ts schedule); this runs from a daily Vercel cron and by hand (SPEC).
export async function sweep(requestUrl: string, send: (requestUrl: string, id: string) => Promise<void> = nudge): Promise<{ failed: number; nudged: number }> {
  const sql = db();

  // A crash runs no code, so only the claim counts it (tries). A row that crashed until it ran out of tries is not
  // claimable any more; this is the one place that tells a human it gave up.
  const failed = await sql`
    UPDATE enquiries
    SET status = 'failed_permanent', last_error = ${`gave up after ${MAX_TRIES} tries: crashed repeatedly`}, locked_until = NULL, updated_at = now()
    WHERE status = 'processing' AND locked_until < now() AND tries >= ${MAX_TRIES}
    RETURNING id`;

  // Out-of-tries rows are excluded everywhere, or they would fill the batch and starve the rows that can still run.
  const stuck = await sql`
    SELECT id FROM enquiries
    WHERE tries < ${MAX_TRIES}
      AND ( (status = 'queued' AND updated_at < now() - interval '1 minute')
            OR (status = 'retrying' AND next_attempt_at <= now())
            OR (status = 'processing' AND locked_until < now()) )
    ORDER BY updated_at, id
    LIMIT ${SWEEP_BATCH}`;

  await Promise.all(stuck.map((row) => send(requestUrl, row.id as string))); // nudge never throws
  return { failed: failed.length, nudged: stuck.length };
}
