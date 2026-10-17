import { timingSafeEqual } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fails closed: with no WORKER_SECRET configured, nobody gets in.
function authorized(header: string | null): boolean {
  const secret = process.env.WORKER_SECRET;
  if (!secret) return false;
  const given = Buffer.from(header ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// T7: receives the nudge and logs the id. T11 turns this into processEnquiry(id).
export async function POST(request: Request) {
  if (!authorized(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }
  const input = await request.json().catch(() => null);
  if (typeof input?.id !== "string" || !UUID.test(input.id)) {
    return Response.json({ error: "id must be a uuid" }, { status: 400 });
  }
  console.log("worker: received", { id: input.id });
  return Response.json({ ok: true });
}
