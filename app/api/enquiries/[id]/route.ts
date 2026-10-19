import { editExtraction } from "@/lib/db/enquiries";
import { extractionSchema } from "@/lib/extraction/schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A human edit of the extracted fields, checked against the version the editor last saw.
// 409 means someone else saved first (or the row is no longer in review): nothing was changed, and the body carries
// the current row so the screen can show the difference. No password gate until T21.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "id must be a uuid" }, { status: 400 });

  const input = await request.json().catch(() => null);
  const version = input?.version;
  if (!Number.isInteger(version) || version < 0) return Response.json({ error: "version must be a non-negative integer" }, { status: 400 });
  const extracted = extractionSchema.safeParse(input.extracted);
  if (!extracted.success) return Response.json({ error: "extracted does not fit the expected shape" }, { status: 400 });

  const result = await editExtraction(id, extracted.data, version);
  if (result.ok) return Response.json({ version: result.version });
  if (!result.current) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ error: "conflict", current: result.current }, { status: 409 });
}
