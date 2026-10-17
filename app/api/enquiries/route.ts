import { createHash } from "node:crypto";
import { after } from "next/server";
import { insertEnquiry } from "@/lib/db/enquiries";
import { nudge } from "@/lib/queue";

// Paste form intake. Same insert as email. The same text on the same UTC day counts as one enquiry.
export async function POST(request: Request) {
  const input = await request.json().catch(() => null);
  const body = typeof input?.body === "string" ? input.body.trim() : "";
  if (!body) return Response.json({ error: "body is required" }, { status: 400 });

  const subject = typeof input.subject === "string" ? input.subject : undefined;
  const sender = typeof input.sender === "string" ? input.sender : undefined;
  const day = new Date().toISOString().slice(0, 10);
  const hash = createHash("sha256").update(`${subject ?? ""}\n${body}`).digest("hex");

  let result;
  try {
    result = await insertEnquiry({ messageId: `paste:${day}:${hash}`, source: "paste", subject, body, sender });
  } catch (err) {
    console.error("enquiries: insert failed", { message: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "storage error" }, { status: 500 });
  }
  const { id, created } = result;
  if (created) after(() => nudge(request.url, id));
  return Response.json({ id, created }, { status: created ? 201 : 200 });
}
