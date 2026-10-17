// The nudge: tells the worker "enquiry <id> is waiting". It carries only the id.
// The row in Postgres is the truth. If a nudge is lost, the sweeper finds the row later, so this never throws.
// Vercel Queues could replace this function without touching the routes.
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
