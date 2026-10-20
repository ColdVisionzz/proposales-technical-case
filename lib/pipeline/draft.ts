import { isDraftLevel } from "../extraction/decide";
import { DEFAULT_LANGUAGE } from "../extraction/policy";
import { resolveQuantity, ruleFor, stayOf } from "../extraction/quantity";
import { dayNumber, type Flag, type Validated } from "../extraction/validate";
import { ENQUIRY_KEY, type CatalogItem, type CreateDraftInput } from "../proposales/gateway";

// "Anna Lindqvist <anna@x.com>" -> { name: "Anna Lindqvist", email: "anna@x.com" }. A bare address works too.
export function parseSender(sender: string | null): { name?: string; email?: string } {
  if (!sender) return {};
  const angle = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(sender);
  if (angle) return { name: angle[1] || undefined, email: angle[2] };
  const bare = sender.trim();
  return /^[^<>\s]+@[^<>\s]+$/.test(bare) ? { email: bare } : {};
}

// Customer text goes into a markdown field: keep each value on one line so it cannot add structure of its own.
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export type DraftInput = {
  enquiryKey: string;
  companyId: number;
  validated: Validated;
  flags: Flag[];
  catalog: CatalogItem[];
  sender: string | null;
};

// Everything here comes from validated values: a field that failed a check is null and simply left out.
export function buildDraft({ enquiryKey, companyId, validated: v, flags, catalog, sender }: DraftInput): { draft: CreateDraftInput; notes: Flag[] } {
  const from = parseSender(sender);
  const client = v.company.value ?? v.contactName.value ?? from.name ?? from.email ?? "New enquiry";

  const start = v.startDate.value;
  const end = v.endDate.value;
  const days = start && end ? (dayNumber(end) as number) - (dayNumber(start) as number) + 1 : null;
  const title = [oneLine(client), v.rooms.value ? plural(v.rooms.value, "room") : null, days ? plural(days, "day") : start]
    .filter(Boolean)
    .join(" · ");

  const titleOf = (id: number) => {
    const item = catalog.find((c) => c.variation_id === id);
    return item ? (item.title.en ?? Object.values(item.title)[0] ?? String(id)) : String(id);
  };

  const guests = v.guests.value as number; // decide() only lets a draft through with guests and a start date
  const notes: Flag[] = [];
  const stay = stayOf(start, end, v.nights.value);
  const blocks = v.products.map((p) => {
    const title = titleOf(p.variationId);
    const { quantity, notes: quantityNotes } = resolveQuantity(title, { guests, rooms: v.rooms.value, stay }, p.quantity);
    for (const message of quantityNotes) notes.push({ field: "products", level: "check", message });
    return { type: "product-block" as const, content_id: p.variationId, quantity };
  });
  // Rooms in the email but no room product to carry them, or more rooms than people: both are likely misreads.
  if (v.rooms.value && !v.products.some((p) => ruleFor(titleOf(p.variationId)) === "per_room_night")) {
    notes.push({ field: "products", level: "check", message: `The email asks for ${plural(v.rooms.value, "room")} but no hotel room product is in the draft: add it if rooms are wanted` });
  }
  if (v.rooms.value && v.rooms.value > guests) {
    notes.push({ field: "rooms", level: "check", message: `${plural(v.rooms.value, "room")} for ${plural(guests, "guest")}: more rooms than guests, check the room count` });
  }

  const lines = [
    "Created automatically from an email enquiry. Check before sending.",
    "",
    `- Dates: ${start ? `${start}${end && end !== start ? ` to ${end}` : ""}` : "not stated"}`,
    `- Guests: ${guests}`,
    ...(v.rooms.value ? [`- Rooms: ${v.rooms.value}${stay.nights !== null ? ` (${plural(stay.nights, "night")})` : ""}`] : []),
    ...(v.products.length ? [`- Requested: ${v.products.map((p) => oneLine(titleOf(p.variationId))).join(", ")}`] : []),
    ...(v.eventType.value ? [`- Event: ${oneLine(v.eventType.value)}`] : []),
    ...(v.budget.value ? [`- Budget: ${oneLine(v.budget.value)}`] : []),
    ...(v.specialRequests.value ? [`- Special requests: ${oneLine(v.specialRequests.value)}`] : []),
    ...(v.contactName.value || from.email ? [`- Contact: ${oneLine([v.contactName.value ?? from.name, from.email].filter(Boolean).join(", "))}`] : []),
  ];
  const check = [...flags.filter(isDraftLevel), ...notes];
  if (check.length) lines.push("", "Check before sending:", ...check.map((f) => `- ${oneLine(f.message)}`));

  // The model's name is checked against the email (its quote must be there); the header's display name is not
  // checked and is often "Sales" or a company. So the header is only the fallback.
  const [firstName, ...rest] = (v.contactName.value ?? from.name ?? "").trim().split(/\s+/).filter(Boolean);
  const draft: CreateDraftInput = {
    company_id: companyId,
    language: v.language.value ?? DEFAULT_LANGUAGE,
    title_md: title,
    description_md: lines.join("\n"),
    data: { [ENQUIRY_KEY]: enquiryKey },
    blocks,
  };
  if (from.email || firstName) {
    draft.recipient = {
      ...(from.email ? { email: from.email } : {}),
      ...(firstName ? { first_name: firstName } : {}),
      ...(rest.length ? { last_name: rest.join(" ") } : {}),
      ...(v.company.value ? { company_name: oneLine(v.company.value) } : {}),
    };
  }
  return { draft, notes };
}
