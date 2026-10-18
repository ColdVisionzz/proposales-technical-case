import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Extraction } from "@/lib/extraction/schema";

// Shared by the validate and decide tests. Not a *.test.ts file, so vitest does not run it on its own.
export const catalog = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "catalog.sample.json"), "utf8")).data;
export const TODAY = "2026-10-18"; // a Sunday
export const email = {
  subject: "Offsite in March",
  body: "Hi, we are 24 people and need the hotel for 12-13 March 2027. We would like a meeting room and lunch. Anna from Northwind AB",
};

type Field<T> = Extraction["guests"] & { value: T | null };
export const f = <T>(value: T | null, evidence: string | null, confidence = 1): Field<T> => ({ value, confidence, evidence }) as Field<T>;
const empty = f<never>(null, null, 0);

// A clean enquiry: everything is in the email, nothing needs a flag.
export function clean(overrides: Partial<Extraction> = {}): Extraction {
  return {
    isEnquiry: true,
    contactName: f("Anna", "Anna from Northwind AB"),
    company: f("Northwind AB", "Northwind AB"),
    eventType: empty,
    startDate: f("2027-03-12", "12-13 March 2027"),
    endDate: f("2027-03-13", "12-13 March 2027"),
    guests: f(24, "24 people"),
    rooms: empty,
    nights: empty,
    language: f("en", "Hi, we are 24 people"),
    budget: empty,
    specialRequests: empty,
    products: [
      { variationId: 3001, confidence: 1, evidence: "a meeting room" },
      { variationId: 3002, confidence: 1, evidence: "lunch" },
    ],
    ...overrides,
  };
}
