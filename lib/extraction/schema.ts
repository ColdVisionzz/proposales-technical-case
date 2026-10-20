import { z } from "zod";

// Every extracted value carries how sure the model is and the exact words that back it up.
// Code checks the words against the email later; a quote that is not found means "unknown".
// No min/max here on purpose: not every provider accepts them in a structured-output schema, so code checks ranges.
const field = <T extends z.ZodType>(value: T) =>
  z.object({
    value: value.nullable().describe("The value, or null when the email does not state it"),
    confidence: z.number().describe("0 to 1: how sure the email makes this value. 0 when value is null"),
    evidence: z.string().nullable().describe("Exact words copied from the email that support the value, or null"),
  });

export const extractionSchema = z.object({
  isEnquiry: z.boolean().describe("false for newsletters, out-of-office replies, spam, receipts, anything that is not a request for hotel services"),
  contactName: field(z.string()),
  company: field(z.string()),
  eventType: field(z.string().describe("For example conference, wedding, team dinner")),
  startDate: field(z.string().describe("ISO date YYYY-MM-DD")),
  endDate: field(z.string().describe("ISO date YYYY-MM-DD")),
  guests: field(z.number().int()),
  rooms: field(z.number().int().describe("Hotel rooms wanted")),
  nights: field(z.number().int()),
  language: field(z.string().describe("ISO 639-1 code of the language the email is written in. Evidence is a short phrase in that language")),
  budget: field(z.string().describe("As written, including currency")),
  specialRequests: field(z.string()),
  products: z
    .array(
      z.object({
        variationId: z.number().int().describe("A variation_id from the catalog. Never an id that is not in the catalog"),
        confidence: z.number().describe("0 to 1"),
        evidence: z.string().describe("Exact words from the email that ask for this product"),
        // .catch(null): rows stored before these fields existed still parse. The field stays required in the model's schema.
        quantity: z
          .number()
          .int()
          .nullable()
          .catch(null)
          .describe("Total units for the whole event, only when the email states a count or a share for this product (5 of 10 guests want dinner: 5). Null when it does not"),
        quantityEvidence: z.string().nullable().catch(null).describe("Exact words from the email that state that count or share, or null"),
      }),
    )
    .describe("Catalog products the email asks for. Empty when nothing fits"),
});

export type Extraction = z.infer<typeof extractionSchema>;

// What a human-edited field carries as its evidence. validate() honours it only on a row with override set, so a
// model (or a hostile email talking to it) that writes these words gains nothing.
export const HAND_EVIDENCE = "(entered by hand)";

// An extraction with every field unknown: the starting point when a human fills in a row the model produced nothing for.
const unknown = { value: null, confidence: 0, evidence: null };
export const emptyExtraction: Extraction = {
  isEnquiry: true,
  contactName: unknown,
  company: unknown,
  eventType: unknown,
  startDate: unknown,
  endDate: unknown,
  guests: unknown,
  rooms: unknown,
  nights: unknown,
  language: unknown,
  budget: unknown,
  specialRequests: unknown,
  products: [],
};
