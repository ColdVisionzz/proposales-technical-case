import { createHash } from "node:crypto";
import { after, connection } from "next/server";
import { insertEnquiry } from "@/lib/db/enquiries";
import { listEnquiries } from "@/lib/db/enquiry-views";
import { readChaos } from "@/lib/db/settings";
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

// The dashboard's list, polled every 2 s. Summaries only (no email body), newest first, plus the chaos switch so the banner
// can show it before the health ping has tripped. An unreadable switch counts as off, like everywhere else.
// No password gate until T21.
export async function GET() {
  await connection(); // runtime data: never prerendered at build
  try {
    const [enquiries, chaos] = await Promise.all([listEnquiries(), readChaos().catch(() => false)]);
    return Response.json({ enquiries, chaos }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("enquiries: list failed", { message: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "storage error" }, { status: 500 });
  }
}
