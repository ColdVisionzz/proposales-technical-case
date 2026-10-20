import { bearerMatches } from "@/lib/auth";
import { sweep } from "@/lib/pipeline/sweeper";

// The safety net for what the delayed retry messages cannot cover (a lost message, a crash, a crash-looped row).
// GET: the daily Vercel cron, which sends `Authorization: Bearer $CRON_SECRET` itself. Fails closed when CRON_SECRET is unset.
// POST: the dashboard's "run sweeper now" button. Open to visitors on purpose (the browser cannot hold the secret): a sweep is
// idempotent, capped at SWEEP_BATCH rows, and the worker's atomic claim still decides who runs a row.
// Answers with how many rows it failed and how many it nudged.
async function run(request: Request) {
  try {
    const result = await sweep(request.url);
    console.log("sweeper: done", result);
    return Response.json(result);
  } catch (err) {
    console.error("sweeper: failed", { message: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "sweep failed" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  return run(request);
}

export const POST = run;
