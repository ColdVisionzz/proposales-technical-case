import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { productionDeps } from "@/lib/pipeline/deps";
import { processEnquiry } from "@/lib/pipeline/process";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fails closed: with no WORKER_SECRET configured, nobody gets in.
function authorized(header: string | null): boolean {
  const secret = process.env.WORKER_SECRET;
  if (!secret) return false;
  const given = Buffer.from(header ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

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
  if (!authorized(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }
  const input = await request.json().catch(() => null);
  if (typeof input?.id !== "string" || !UUID.test(input.id)) {
    return Response.json({ error: "id must be a uuid" }, { status: 400 });
  }
  const id: string = input.id;
  after(() => run(id));
  return Response.json({ ok: true }, { status: 202 });
}
