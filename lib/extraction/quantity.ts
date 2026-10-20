// Days since 1970-01-01 for a real calendar day written YYYY-MM-DD, otherwise null (so 2027-02-30 is null).
export function dayNumber(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? date.getTime() / 86_400_000 : null;
}

// How many of a product to put in the draft. The API's catalog says nothing about units, so we keep the rule here.
//   one             a single item (anything not listed below)
//   per_day         one per event day (meeting room, AV package: catalog unit "day")
//   per_guest_day   one per guest per event day (lunch, dinner)
//   per_room_night  one per hotel room per night
// Keyed by the English product title, not the id: ids differ from account to account, the seeded titles do not.
// ponytail: a renamed product silently falls back to "one". Key by a custom field if hotels rename their products.
export type QuantityRule = "one" | "per_day" | "per_guest_day" | "per_room_night";
export const QUANTITY_RULES: Record<string, QuantityRule> = {
  lunch: "per_guest_day",
  dinner: "per_guest_day",
  "hotel room": "per_room_night",
  "meeting room": "per_day",
  "av package": "per_day",
};
export const ruleFor = (title: string): QuantityRule => QUANTITY_RULES[title.trim().toLowerCase()] ?? "one";

// Event days run start..end inclusive. Nights run start..end, the end date being the departure day.
// nights null = unknown (no end date and none stated). Guests may arrive before the event, so a stated night count
// of 1 or more wins over the dates; the difference is reported, never silent.
export type Stay = { days: number; nights: number | null; mismatch: boolean };

export function stayOf(start: string | null, end: string | null, statedNights: number | null): Stay {
  const s = start ? dayNumber(start) : null;
  const e = end ? dayNumber(end) : null;
  const derived = s !== null && e !== null && e >= s ? e - s : null;
  const stated = statedNights !== null && statedNights >= 1 ? statedNights : null;
  const nights = stated ?? derived;
  return { days: derived !== null ? derived + 1 : 1, nights, mismatch: stated !== null && derived !== null && stated !== derived };
}

export type QuantityContext = { guests: number; rooms: number | null; stay: Stay };

// The most units a product can sensibly have. A stated quantity above this is a typo or a trick, not an enquiry.
// ponytail: "one" and per-day products (several breakout rooms are legitimate) are capped by people, not by a catalog limit.
export function ceilingFor(title: string, { guests, rooms, stay }: QuantityContext): number {
  switch (ruleFor(title)) {
    case "per_room_night": return (rooms ?? guests) * Math.max(stay.nights ?? 1, 1);
    case "per_guest_day":
    case "per_day": return guests * stay.days;
    default: return guests;
  }
}

// `stated` is a total the email gave and validate() already verified. It replaces the default rule; the default
// only guesses, so every guess that could be off comes back as a note for the salesperson.
export function resolveQuantity(title: string, ctx: QuantityContext, stated: number | null = null): { quantity: number; notes: string[] } {
  if (stated !== null) return { quantity: stated, notes: [] };
  const { guests, rooms, stay } = ctx;
  const name = `"${title}"`;
  switch (ruleFor(title)) {
    case "per_day":
      return { quantity: stay.days, notes: [] };
    case "per_guest_day":
      return {
        quantity: guests * stay.days,
        notes: stay.days > 1 ? [`${name}: assumed all ${guests} guests on each of ${stay.days} days, the email does not say who attends which day`] : [],
      };
    case "per_room_night": {
      if (!rooms) return { quantity: 1, notes: [`${name} is priced per room per night but the email gives no room count: quantity set to 1, check it`] };
      const notes: string[] = [];
      if (stay.nights === null) notes.push(`${name}: no end date or night count, one night assumed`);
      else if (stay.nights === 0) notes.push(`${name}: the dates are a single day, one night assumed`);
      if (stay.mismatch) notes.push(`${name}: the nights stated in the email differ from the nights between the dates, the stated nights were used`);
      return { quantity: rooms * Math.max(stay.nights ?? 1, 1), notes };
    }
    default:
      return { quantity: 1, notes: [] };
  }
}
