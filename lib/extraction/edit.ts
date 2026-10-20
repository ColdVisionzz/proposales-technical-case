import { z } from "zod";
import { extractionSchema, HAND_EVIDENCE } from "./schema";

const FIELD_NAMES = Object.keys(extractionSchema.shape).filter((k) => k !== "isEnquiry" && k !== "products");

export type Changes = Record<string, unknown>;

// A save carries only the fields the user changed: { guests: 40 }, null to clear, products as a list of variation ids.
// Each one becomes the same shape the model produces, marked as entered by hand, so the server can merge it into the stored
// extraction. Fields the user did not touch are never sent, which is how a masked address on screen can never overwrite a real one.
export function parseChanges(input: unknown): { ok: true; changes: Changes } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "changes must be an object" };
  const out: Changes = {};
  for (const [key, raw] of Object.entries(input)) {
    if (key === "products") {
      const ids = z.array(z.number().int()).safeParse(raw);
      if (!ids.success) return { ok: false, error: "products must be a list of variation ids" };
      out.products = [...new Set(ids.data)].map((variationId) => ({ variationId, confidence: 1, evidence: HAND_EVIDENCE }));
    } else if (FIELD_NAMES.includes(key)) {
      const value = (extractionSchema.shape as unknown as Record<string, z.ZodObject<{ value: z.ZodType }>>)[key].shape.value.safeParse(raw);
      if (!value.success) return { ok: false, error: `${key} has the wrong type` };
      // The screen shows addresses masked (a***@host). Saving that text would overwrite the real address for good.
      if (typeof value.data === "string" && value.data.includes("***@")) return { ok: false, error: `${key} contains a hidden email address: retype the full text` };
      out[key] = value.data === null ? { value: null, confidence: 0, evidence: null } : { value: value.data, confidence: 1, evidence: HAND_EVIDENCE };
    } else {
      return { ok: false, error: `${key} cannot be edited` };
    }
  }
  if (Object.keys(out).length === 0) return { ok: false, error: "changes is empty" };
  return { ok: true, changes: out };
}
