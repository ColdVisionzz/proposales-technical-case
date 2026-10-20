import { ceilingFor, resolveQuantity, stayOf } from "../extraction/quantity";
import { extractionSchema, type Extraction } from "../extraction/schema";

// Pure functions behind the dashboard: what each status looks like in the pipe, plain-language errors, the booking card.
// No React and no fetching, so every branch is unit-testable.

export type Status = "queued" | "processing" | "retrying" | "draft_created" | "needs_review" | "failed_permanent" | "ignored";
export type Mood = "waiting" | "moving" | "stalled" | "done" | "stopped" | "failed" | "drained";

// Where the mail packet sits in the pipe. 0 = inbox (right), 1 = output (left). The AI node sits at AI_AT.
export const AI_AT = 0.45;
const CREATING_AT = 0.75;

// The four stages the rail shows, in order. A pipe position (`at`) maps onto one of them.
export const STAGES = [
  { label: "Received", sub: "Email stored" },
  { label: "Reading", sub: "Extracting details" },
  { label: "Drafting", sub: "Building the proposal" },
  { label: "Draft ready", sub: "Ready to review" },
] as const;

export function stageIndex(at: number): number {
  return at >= 1 ? 3 : at >= CREATING_AT ? 2 : at >= AI_AT ? 1 : 0;
}

export type PipeView = { at: number; mood: Mood; headline: string; sub: string };

type PipeInput = { status: string; step: string | null; lastError: string | null; nextAttemptAt: string | null };

const READING_STEPS = new Set([null, "received", "claimed", "body_fetched"]);

// One answer to "what should the pipe show right now?". Status alone cannot tell reading from creating: the latest event can.
export function pipeView(e: PipeInput, now: number): PipeView {
  switch (e.status) {
    case "queued":
      return { at: 0, mood: "waiting", headline: "Mail received", sub: "Waiting for a worker to pick it up" };
    case "processing":
      return READING_STEPS.has(e.step)
        ? { at: AI_AT, mood: "moving", headline: "Extracting", sub: "The AI is reading the email" }
        : { at: CREATING_AT, mood: "moving", headline: "Creating the draft", sub: "Matching products and building the proposal" };
    case "retrying": {
      const wait = e.nextAttemptAt ? Math.max(0, Math.ceil((Date.parse(e.nextAttemptAt) - now) / 1000)) : null;
      return {
        at: CREATING_AT,
        mood: "stalled",
        headline: "Waiting to retry",
        sub: `${explainError(e.lastError)}${wait === null ? "" : wait > 0 ? ` Trying again in ${wait} s.` : " Trying again now."}`,
      };
    }
    case "draft_created":
      return { at: 1, mood: "done", headline: "Draft ready", sub: "Open it in Proposales to review and send" };
    case "needs_review":
      return { at: AI_AT, mood: "stopped", headline: "Needs a human", sub: "Something was missing or unclear, so no draft was made" };
    case "failed_permanent":
      return { at: CREATING_AT, mood: "failed", headline: "Stopped", sub: explainError(e.lastError) };
    case "ignored":
      return { at: AI_AT, mood: "drained", headline: "Not an enquiry", sub: "This email does not ask for hotel services" };
    default:
      return { at: 0, mood: "waiting", headline: e.status, sub: "" };
  }
}

// last_error is stored as "retryable: upstream_503", "permanent: bad_request_400 (detail)" or "gave up after 5 tries: retryable: ...".
// Turn it into a sentence a salesperson can act on. Unknown codes fall back to a generic line, never to the raw code.
export function explainError(lastError: string | null): string {
  if (!lastError) return "Something went wrong, no details were saved.";
  const gaveUp = /^gave up after (\d+) tries?/.exec(lastError);
  const reason = /(?:retryable|permanent): ([a-z_0-9]+)/.exec(lastError)?.[1] ?? "";
  const why = reasonText(reason);
  return gaveUp ? `Gave up after ${gaveUp[1]} tries. ${why}` : why;
}

function reasonText(reason: string): string {
  if (reason === "auth") return "Proposales rejected our API key. Check the key in the project settings.";
  if (reason === "chaos") return "The demo failure switch is on, so Proposales calls are failing on purpose.";
  if (reason === "rate_limited") return "Proposales asked us to slow down.";
  if (reason === "timeout" || reason === "network") return "Could not reach Proposales in time.";
  if (reason === "database") return "Our database was briefly unavailable.";
  if (reason === "duplicate_in_flight") return "The same email is already being processed.";
  if (/^upstream_\d+$/.test(reason)) return "Proposales had a server problem.";
  if (/^bad_request_\d+$/.test(reason)) return "Proposales refused the draft as invalid. Fix the data and retry.";
  return "Something unexpected went wrong.";
}

// "4 s", "1 min 12 s". In flight it counts up to now; finished rows stop at their last update.
const FINISHED = new Set(["draft_created", "needs_review", "failed_permanent", "ignored"]);

export function timeTaken(e: { status: string; createdAt: string; updatedAt: string }, now: number): string {
  const end = FINISHED.has(e.status) ? Date.parse(e.updatedAt) : now;
  const s = Math.max(0, Math.round((end - Date.parse(e.createdAt)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const STATUS_LABEL: Record<Status, string> = {
  queued: "Queued",
  processing: "Working",
  retrying: "Retrying",
  draft_created: "Draft ready",
  needs_review: "Needs review",
  failed_permanent: "Failed",
  ignored: "Ignored",
};

// ---- Booking card ----------------------------------------------------------------------------------------------------------

export type BookingLine = { label: string; quantity: number };
export type Booking = { facts: { label: string; value: string }[]; lines: BookingLine[] };

// What the model read from the email, laid out like the draft's lines. Quantities use the same rule as the real draft
// (quantityFor), so the card and the draft agree. catalog null = names unavailable: show "product #id" rather than hide it.
// With a catalog, an id that is not in it is dropped: extracted is raw model output and an unknown id is not a booked product.
export function booking(extracted: unknown, catalog: Map<number, string> | null): Booking | null {
  const parsed = extractionSchema.safeParse(extracted);
  if (!parsed.success) return null;
  const x: Extraction = parsed.data;
  const guests = x.guests.value;
  const lines: BookingLine[] = [];
  const stay = stayOf(x.startDate.value, x.endDate.value, x.nights.value);
  for (const p of x.products) {
    const title = catalog ? catalog.get(p.variationId) : `product #${p.variationId}`;
    if (title === undefined) continue;
    // The card has no email text to check a stated quantity against, so it shows one only when it fits the booking.
    const ctx = { guests: guests ?? 1, rooms: x.rooms.value, stay };
    const stated = p.quantity !== null && Number.isInteger(p.quantity) && p.quantity >= 1 && p.quantity <= ceilingFor(title, ctx) ? p.quantity : null;
    const { quantity } = catalog ? resolveQuantity(title, ctx, stated) : { quantity: 1 };
    lines.push({ label: title, quantity });
  }
  const dates = x.startDate.value ? niceDates(x.startDate.value, x.endDate.value) : null;
  const facts = [
    x.company.value ?? x.contactName.value ? { label: "For", value: String(x.company.value ?? x.contactName.value) } : null,
    x.eventType.value ? { label: "Event", value: x.eventType.value } : null,
    dates ? { label: "Dates", value: dates } : null,
    guests !== null ? { label: "Guests", value: `${guests} ${guests === 1 ? "guest" : "guests"}` } : null,
  ].filter((f): f is { label: string; value: string } => f !== null);
  return { facts, lines };
}

// "2027-03-12", "2027-03-13" -> "12–13 Mar 2027". Falls back to the raw text for anything that is not an ISO date.
export function niceDates(start: string, end: string | null): string {
  const fmt = (iso: string, parts: Intl.DateTimeFormatOptions) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { ...parts, timeZone: "UTC" }) : iso);
  const full = { day: "numeric", month: "short", year: "numeric" } as const;
  if (!end || end === start) return fmt(start, full);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return sameMonth ? `${fmt(start, { day: "numeric" })}–${fmt(end, full)}` : `${fmt(start, { day: "numeric", month: "short" })} – ${fmt(end, full)}`;
}

// "1 hotel room", "12 lunches": the label as the mockup writes it.
export function lineText({ label, quantity }: BookingLine): string {
  const name = label.toLowerCase();
  if (quantity === 1) return `1 ${name}`;
  return `${quantity} ${/(ch|sh|s|x)$/.test(name) ? `${name}es` : `${name}s`}`;
}

// ---- Evidence highlighting -------------------------------------------------------------------------------------------------

export type Segment = { text: string; keys: string[] };

const QUOTES = /['‘’‛]/;
const DQUOTES = /["“”]/;
const DASHES = /[\u2010-\u2015\u2212-]/;

// Find each quote in the original text (so offsets are real) and cut the text at every quote edge. A segment lists every key whose
// quote covers it, so two fields sharing a phrase both light up. Spacing, case, curly quotes and dashes may differ, as in validate.ts.
// A quote that is not found highlights nothing: the row still shows it.
export function highlight(body: string, items: { key: string; evidence: string | null }[]): Segment[] {
  const ranges: { key: string; start: number; end: number }[] = [];
  for (const { key, evidence } of items) {
    const words = evidence?.normalize("NFKC").trim().split(/\s+/).filter(Boolean) ?? [];
    if (!words.length) continue;
    const pattern = words
      .map((w) => [...w].map((c) => (QUOTES.test(c) ? QUOTES.source : DQUOTES.test(c) ? DQUOTES.source : DASHES.test(c) ? DASHES.source : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join(""))
      .join("\\s+");
    const m = new RegExp(pattern, "i").exec(body);
    if (m) ranges.push({ key, start: m.index, end: m.index + m[0].length });
  }
  const cuts = [...new Set([0, body.length, ...ranges.flatMap((r) => [r.start, r.end])])].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    out.push({ text: body.slice(a, b), keys: ranges.filter((r) => r.start <= a && r.end >= b).map((r) => r.key) });
  }
  return out;
}

// ---- Timeline --------------------------------------------------------------------------------------------------------------

const STEP_LABEL: Record<string, string> = {
  received: "Email received",
  claimed: "Picked up",
  body_fetched: "Email text fetched",
  extracted: "Details extracted",
  decided: "Decision made",
  draft_found: "Existing draft found",
  draft_created: "Draft created in Proposales",
  retry_scheduled: "Retry scheduled",
  failed: "Failed",
  done: "Finished",
};

export const stepLabel = (step: string) => STEP_LABEL[step] ?? step;
