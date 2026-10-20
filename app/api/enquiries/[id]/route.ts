import { connection } from "next/server";
import { editExtraction } from "@/lib/db/enquiries";
import { maskDeep } from "@/lib/db/mask";
import { getEnquiryDetail } from "@/lib/db/enquiry-views";
import { parseChanges } from "@/lib/extraction/edit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A human edit: only the fields the user changed (`{ version, changes: { guests: 40 } }`), checked against the version
// the editor last saw. The server merges them into the stored extraction, so masked text on screen is never written back.
// 409 means someone else saved first (or the row is no longer in review): nothing was changed, and the body carries
// the current row so the screen can show the difference.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "id must be a uuid" }, { status: 400 });

  const input = await request.json().catch(() => null);
  const version = input?.version;
  if (!Number.isInteger(version) || version < 0) return Response.json({ error: "version must be a non-negative integer" }, { status: 400 });
  const parsed = parseChanges(input.changes);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const result = await editExtraction(id, parsed.changes, version);
  if (result.ok) return Response.json({ version: result.version });
  if (!result.current) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ error: "conflict", current: maskDeep(result.current) }, { status: 409 });
}

// One enquiry in full for the drawer: the original email, the extracted fields and the event timeline.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "id must be a uuid" }, { status: 400 });
  try {
    const detail = await getEnquiryDetail(id);
    if (!detail) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(detail, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("enquiries: detail failed", { message: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "storage error" }, { status: 500 });
  }
}
