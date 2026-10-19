import { after } from "next/server";
import { retryEnquiry } from "@/lib/db/enquiries";
import { nudge } from "@/lib/queue";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Manual retry of a row that gave up. Re-queues it with a fresh try count, then nudges the worker.
// 409 means the row is not in failed_permanent (already retried, or never failed). No password gate until T21.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "id must be a uuid" }, { status: 400 });

  const result = await retryEnquiry(id);
  if (result.ok) {
    after(() => nudge(request.url, id));
    return Response.json({ ok: true });
  }
  if (result.status === null) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ error: "conflict", status: result.status }, { status: 409 });
}
