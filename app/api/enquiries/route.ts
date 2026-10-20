import { connection } from "next/server";
import { listEnquiries } from "@/lib/db/enquiry-views";
import { readChaos } from "@/lib/db/settings";

// Read only. Enquiries enter through the signed email webhook (`/api/inbound`) and nowhere else, so there is no public write
// route here and nothing for a stranger to spend model calls on.
//
// The dashboard's list, polled every 2 s. Summaries only (no email body), newest first, plus the chaos switch so the banner
// can show it before the health ping has tripped. An unreadable switch counts as off, like everywhere else.
//
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
