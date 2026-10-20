import type { CatalogEntry, EmailInput } from "./extract";
import { policy as defaultPolicy, type Policy } from "./policy";
import { ceilingFor, dayNumber, localized, stayOf } from "./quantity";
import { HAND_EVIDENCE, type Extraction } from "./schema";


// "unsupported": the model's value failed a check and was dropped (the claim is kept for the salesperson to see).
// "check": the value is kept, but a human should look at it.
export type Flag = { field: string; level: "check" | "unsupported"; message: string; claimed?: unknown; evidence?: string | null };

// `value` is what code trusts and may use. `claimed` is what the model said. They differ only when a check dropped the value.
export type Checked<T> = { value: T | null; claimed: T | null; confidence: number; evidence: string | null };

export type Validated = {
  isEnquiry: boolean;
  contactName: Checked<string>;
  company: Checked<string>;
  eventType: Checked<string>;
  startDate: Checked<string>;
  endDate: Checked<string>;
  guests: Checked<number>;
  rooms: Checked<number>;
  nights: Checked<number>;
  language: Checked<string>;
  budget: Checked<string>;
  specialRequests: Checked<string>;
  products: Array<{ variationId: number; confidence: number; evidence: string; quantity: number | null }>;
  flags: Flag[];
};

type Raw<T> = { value: T | null; confidence: number; evidence: string | null };

// Spacing, case, curly quotes and dash styles may differ between the email and the model's copy. The words may not.
export function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const evidenceFound = (evidence: string | null, emailNorm: string) => {
  const quote = evidence ? normalise(evidence) : "";
  return quote !== "" && emailNorm.includes(quote);
};

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const positiveInt = (n: number) => Number.isInteger(n) && n >= 1;
// "1 000" and "1,000" count as 1000 when looking for the number in a quote.
const numberInQuote = (n: number, quote: string) =>
  new RegExp(`(?<!\\d)${n}(?!\\d)`).test(quote.replace(/(?<=\d)[\s,.](?=\d{3}(?!\d))/g, ""));

// `trusted` is true only for a row a human released with "create draft anyway": fields they typed (marked with
// HAND_EVIDENCE) skip the evidence and confidence checks, which cannot apply to a person. Every rule about the world
// (real dates, order, future, guest range, catalog ids) still runs on them, and untouched model fields are checked as before.
export function validate(extraction: Extraction, email: Pick<EmailInput, "subject" | "body">, catalog: CatalogEntry[], today: string, policy: Policy = defaultPolicy, trusted = false): Validated {
  const todayDay = dayNumber(today);
  if (todayDay === null) throw new Error(`today must be YYYY-MM-DD, got ${today}`);
  const emailNorm = normalise(`${email.subject}\n${email.body}`);
  const flags: Flag[] = [];

  const none = <T>(): Checked<T> => ({ value: null, claimed: null, confidence: 0, evidence: null });
  if (!extraction.isEnquiry) {
    return {
      isEnquiry: false, contactName: none(), company: none(), eventType: none(), startDate: none(), endDate: none(),
      guests: none(), rooms: none(), nights: none(), language: none(), budget: none(), specialRequests: none(), products: [], flags,
    };
  }

  // One field, in order: quote must be in the email, then the field's own rule, then the confidence band.
  function field<T extends string | number>(
    name: string,
    raw: Raw<T>,
    opts: { critical?: boolean; reject?: (value: T) => string | null; warn?: (value: T, evidence: string, byHand: boolean) => string[] } = {},
  ): Checked<T> {
    const byHand = trusted && raw.evidence === HAND_EVIDENCE;
    const confidence = byHand ? 1 : clamp(raw.confidence);
    const out: Checked<T> = { value: null, claimed: raw.value, confidence, evidence: raw.evidence };
    if (raw.value === null) return out; // nothing claimed, nothing to check (decide() reports missing critical fields)
    const drop = (message: string) => {
      flags.push({ field: name, level: "unsupported", message, claimed: raw.value, evidence: raw.evidence });
      return out;
    };
    const check = (message: string) => flags.push({ field: name, level: "check", message, claimed: raw.value, evidence: raw.evidence });

    if (!byHand && !evidenceFound(raw.evidence, emailNorm)) return drop("The words the model quoted for this are not in the email");
    const rejected = opts.reject?.(raw.value);
    if (rejected) return drop(rejected);
    if (confidence < policy.examine) {
      if (opts.critical) return drop(`The model was not confident enough about this (${confidence})`);
      check(`Low confidence (${confidence})`);
    } else if (confidence < policy.certain) {
      check(`The model was only fairly sure about this (${confidence})`);
    }
    for (const message of opts.warn?.(raw.value, raw.evidence as string, byHand) ?? []) check(message);
    out.value = raw.value;
    return out;
  }

  const daysUntil = (date: string) => (dayNumber(date) as number) - todayDay;
  const dateRule = (date: string) => {
    if (dayNumber(date) === null) return "This is not a real calendar date";
    return daysUntil(date) < 0 ? "This date is in the past" : null;
  };

  const startDate = field("startDate", extraction.startDate, {
    critical: true,
    reject: dateRule,
    warn: (date) => (daysUntil(date) <= policy.shortNoticeDays ? [`Short notice: the event starts in ${daysUntil(date)} day(s)`] : []),
  });
  const endDate = field("endDate", extraction.endDate, { reject: dateRule });
  if (startDate.value && endDate.value && (dayNumber(endDate.value) as number) < (dayNumber(startDate.value) as number)) {
    const message = "Conflicting dates: the end date is before the start date";
    for (const checked of [startDate, endDate]) checked.value = null;
    flags.push({ field: "startDate", level: "unsupported", message, claimed: startDate.claimed, evidence: startDate.evidence });
    flags.push({ field: "endDate", level: "unsupported", message, claimed: endDate.claimed, evidence: endDate.evidence });
  }

  const guests = field("guests", extraction.guests, {
    critical: true,
    reject: (n) => (positiveInt(n) && n <= policy.maxGuests ? null : `A guest count must be a whole number from 1 to ${policy.maxGuests}`),
    warn: (n, evidence, byHand) => [
      ...(n > policy.largeGroup ? [`Very large group (${n} guests)`] : []),
      ...(byHand || numberInQuote(n, evidence) ? [] : ["The guest number does not appear as digits in the quoted words"]),
    ],
  });

  const wholeNumber = (what: string) => (n: number) => (positiveInt(n) ? null : `${what} must be a whole number of at least 1`);
  const language = field("language", extraction.language, {
    reject: (code) => (/^[a-z]{2}$/i.test(code) ? null : "The language must be a two-letter code"),
  });
  if (language.value) language.value = language.value.toLowerCase();
  else flags.push({ field: "language", level: "check", message: "Language unknown: the draft will default to English" });

  const rooms = field("rooms", extraction.rooms, { reject: wholeNumber("Rooms") });
  // A day event has 0 nights, so unlike rooms this may be 0.
  const nights = field("nights", extraction.nights, { reject: (n) => (Number.isInteger(n) && n >= 0 ? null : "Nights must be a whole number, 0 or more") });

  // Products: only catalog ids, once each, with a quote in the email and enough confidence.
  const catalogIds = new Set(catalog.map((c) => c.variation_id));
  const productName = (id: number) => {
    const item = catalog.find((c) => c.variation_id === id);
    return item ? `"${localized(item.title) || id}"` : String(id);
  };
  const stay = stayOf(startDate.value, endDate.value, nights.value);

  // A quantity the email states replaces the default rule only if its words are in the email, the number is a whole
  // number from 1 up to what the booking can hold, and the guest count it depends on is trusted. Otherwise null (the
  // default applies) with a flag; a quantity that cannot be checked never reaches a draft.
  const statedQuantity = (product: Extraction["products"][number], title: string, byHand: boolean): number | null => {
    const { quantity, quantityEvidence } = product;
    if (quantity === null || byHand) return null;
    const flag = (message: string) => flags.push({ field: "products", level: "check", message: `${productName(product.variationId)}: stated quantity ${quantity} ignored, ${message}`, claimed: quantity, evidence: quantityEvidence });
    if (guests.value === null) return null; // no draft without a guest count; decide() reports it
    if (!positiveInt(quantity)) return flag("it is not a whole number of at least 1"), null;
    if (!evidenceFound(quantityEvidence, emailNorm)) return flag("its quoted words are not in the email"), null;
    const ceiling = ceilingFor(title, { guests: guests.value, rooms: rooms.value, stay });
    if (quantity > ceiling) return flag(`more than the booking can hold (${ceiling})`), null;
    if (!numberInQuote(quantity, quantityEvidence as string)) {
      flags.push({ field: "products", level: "check", message: `${productName(product.variationId)}: quantity ${quantity} was worked out by the model, check it`, claimed: quantity, evidence: quantityEvidence });
    }
    return quantity;
  };
  const products: Validated["products"] = [];
  for (const product of extraction.products) {
    const drop = (message: string) => flags.push({ field: "products", level: "unsupported", message, claimed: product.variationId, evidence: product.evidence });
    const byHand = trusted && product.evidence === HAND_EVIDENCE;
    const confidence = byHand ? 1 : clamp(product.confidence);
    if (!catalogIds.has(product.variationId)) drop("The model picked a product that is not in the catalog, so it was left out");
    else if (products.some((p) => p.variationId === product.variationId)) continue;
    else if (!byHand && !evidenceFound(product.evidence, emailNorm)) drop(`${productName(product.variationId)} left out: its quoted words are not in the email`);
    else if (confidence < policy.examine) drop(`${productName(product.variationId)} left out: the model was not confident enough (${confidence})`);
    else {
      if (confidence < policy.certain) flags.push({ field: "products", level: "check", message: `${productName(product.variationId)}: the model was only fairly sure (${confidence})`, claimed: product.variationId, evidence: product.evidence });
      const title = catalog.find((c) => c.variation_id === product.variationId)?.title;
      const quantity = statedQuantity(product, title ? localized(title) : "", byHand);
      products.push({ variationId: product.variationId, confidence, evidence: product.evidence, quantity });
    }
  }
  if (products.length === 0) flags.push({ field: "products", level: "check", message: "No catalog product matched this enquiry: add the blocks by hand" });

  return {
    isEnquiry: true,
    contactName: field("contactName", extraction.contactName),
    company: field("company", extraction.company),
    eventType: field("eventType", extraction.eventType),
    startDate,
    endDate,
    guests,
    rooms,
    nights,
    language,
    budget: field("budget", extraction.budget),
    specialRequests: field("specialRequests", extraction.specialRequests),
    products,
    flags,
  };
}
