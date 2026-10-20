import { after } from "next/server";
import { bearerMatches } from "@/lib/auth";
import { productionDeps } from "@/lib/pipeline/deps";
import { processEnquiry } from "@/lib/pipeline/process";
import { isUuid } from "@/lib/uuid";

// Just under the 2 minute lease (claimEnquiry). The platform kills the function before another worker may take the row
// over, so a stalled worker cannot keep running past its lease. The worst chain (body fetch, catalog,
// two model tries, search, create) waits about 100 s. Next's docs: after() runs for the route's configured max duration.
export const maxDuration = 110;

async function run(id: string) {
  try {
    const result = await processEnquiry(id, productionDeps());
    console.log("worker: done", { id, result });
  } catch (err) {
    // Reaches here only if the database itself failed. The lease expires and the sweeper picks the row up.
    console.error("worker: failed", { id, message: err instanceof Error ? err.message : String(err) });
  }
}

// Answers 202 at once and does the work after the response. Otherwise the intake request that nudged us would
// stay open for the whole job.
export async function POST(request: Request) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.WORKER_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  const input = await request.json().catch(() => null);
  if (!isUuid(input?.id)) {
    return Response.json({ error: "id must be a uuid" }, { status: 400 });
  }
  const id: string = input.id;
  after(() => run(id));
  return Response.json({ ok: true }, { status: 202 });
}
