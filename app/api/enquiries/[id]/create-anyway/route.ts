import { after } from "next/server";
import { createAnyway, getForOverride } from "@/lib/db/enquiries";
import { maskDeep } from "@/lib/db/mask";
import { overrideProblems } from "@/lib/extraction/decide";
import { extractionSchema } from "@/lib/extraction/schema";
import { validate } from "@/lib/extraction/validate";
import { getGateway } from "@/lib/pipeline/proposales";
import { nudge } from "@/lib/queue";
import { isUuid } from "@/lib/uuid";

// "Create draft anyway": the human has filled in what the model could not find. We check the hard rules first so a bad
// value is refused with a reason (422), then one version-checked UPDATE hands the row back to the queue with override set.
// Reading first and updating second is safe here: the UPDATE only succeeds if the version is still the one we read, and no
// worker touches a needs_review row, so what we checked is what gets queued.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "id must be a uuid" }, { status: 400 });
  const input = await request.json().catch(() => null);
  const version = input?.version;
  if (!Number.isInteger(version) || version < 0) return Response.json({ error: "version must be a non-negative integer" }, { status: 400 });

  const row = await getForOverride(id);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  if (row.status !== "needs_review" || row.version !== version) {
    return Response.json({ error: "conflict", current: maskDeep({ status: row.status, version: row.version, extracted: row.extracted }) }, { status: 409 });
  }

  const extraction = extractionSchema.safeParse(row.extracted);
  if (!extraction.success) return Response.json({ error: "unprocessable", problems: ["Nothing has been filled in yet"] }, { status: 422 });
  let catalog;
  try {
    catalog = await getGateway().getCatalog();
  } catch (err) {
    console.error("create-anyway: catalog failed", { message: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "catalog unavailable" }, { status: 502 });
  }
  const today = new Date().toISOString().slice(0, 10);
  const problems = overrideProblems(validate(extraction.data, { subject: row.subject, body: row.body }, catalog, today, undefined, true));
  if (problems.length) return Response.json({ error: "unprocessable", problems }, { status: 422 });

  const result = await createAnyway(id, version);
  if (result.ok) {
    after(() => nudge(request.url, id));
    return Response.json({ ok: true, version: result.version });
  }
  return Response.json({ error: "conflict", current: result.current ? maskDeep(result.current) : null }, { status: 409 });
}
