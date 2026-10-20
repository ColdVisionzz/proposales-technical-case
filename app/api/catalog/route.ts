import { connection } from "next/server";
import { getGateway } from "@/lib/pipeline/gateway";

// Product names for the dashboard's booking card, fetched once per page load (not in the 2 s poll).
// Deliberately NOT behind the chaos wrapper: the demo outage is about creating drafts, and names are display only.
// The browser keeps the answer for 5 minutes; the screen falls back to "product #id" if this fails.
//
export async function GET() {
  await connection();
  try {
    const items = await getGateway().getCatalog();
    const products = items.map((c) => ({ variationId: c.variation_id, title: c.title.en ?? Object.values(c.title)[0] ?? String(c.variation_id) }));
    return Response.json({ products }, { headers: { "cache-control": "private, max-age=300" } });
  } catch (err) {
    console.error("catalog: failed", { message: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "catalog unavailable" }, { status: 502 });
  }
}
