import { bearerMatches } from "@/lib/auth";
import { sweep } from "@/lib/pipeline/sweeper";

// The safety net for what the delayed retry messages cannot cover (a lost message, a crash, a crash-looped row).
// GET: the daily Vercel cron, which sends `Authorization: Bearer $CRON_SECRET` itself. POST: "run sweeper now", same header.
// Fails closed when CRON_SECRET is unset. Answers with how many rows it failed and how many it nudged.
async function handle(request: Request) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  try {
    const result = await sweep(request.url);
    console.log("sweeper: done", result);
    return Response.json(result);
  } catch (err) {
    console.error("sweeper: failed", { message: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "sweep failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
