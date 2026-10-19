import { send } from "@vercel/queue";

// The delayed wake-up for a parked (retrying) row: after the backoff, Vercel Queues delivers { id } to the private
// consumer route (app/api/queues/retry). Nothing polls and nothing runs while the row waits.
// The row in Postgres is the truth and was already saved as `retrying`, so a message that cannot be sent is only logged:
// the daily sweeper finds the row later. A duplicate message is harmless, the claim decides, so no idempotency key
// (a keyed send costs double). Never throws, like nudge.
export const RETRY_TOPIC = "enquiry-retry";

export async function schedule(id: string, delaySeconds: number): Promise<void> {
  try {
    await send(RETRY_TOPIC, { id }, { delaySeconds: Math.ceil(delaySeconds) }); // whole seconds; the maximum delay is 7 days
  } catch (err) {
    console.error("schedule: failed", { id, message: err instanceof Error ? err.message : String(err) });
  }
}

// The nudge: tells the worker "enquiry <id> is waiting". It carries only the id.
// The row in Postgres is the truth. If a nudge is lost, the sweeper finds the row later, so this never throws.
export async function nudge(requestUrl: string, id: string): Promise<void> {
  try {
    const res = await fetch(new URL("/api/worker", requestUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.WORKER_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error("nudge: worker refused", { id, status: res.status });
  } catch (err) {
    console.error("nudge: failed", { id, message: err instanceof Error ? err.message : String(err) });
  }
}
