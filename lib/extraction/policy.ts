// Every number the validation and the outcome decision depend on, in one place.
// Switching to a model whose confidence numbers mean something different is an edit here and nowhere else.
export type Policy = {
  certain: number; // confidence at or above this: trusted without a flag
  examine: number; // at or above: trusted, flagged "check this"; below: low confidence
  maxGuests: number; // above this a guest count is treated as a typo or junk. Hardcoded until each hotel can set its own
  largeGroup: number; // above this a guest count is valid but flagged
  shortNoticeDays: number; // a start date this many days away or fewer is flagged
};

export const policy: Policy = { certain: 0.8, examine: 0.6, maxGuests: 1000, largeGroup: 200, shortNoticeDays: 7 };

// A flag on one of these fields makes the whole draft a "flagged draft". A flag on any other field
// (company, rooms, nights, budget, ...) stays attached to that field and does not flag the draft.
// "email" is the flag for an email that was too long and cut short.
export const draftLevelFields: readonly string[] = ["startDate", "endDate", "guests", "products", "language", "email"];

// Draft language when the email's language is unknown or unusable.
export const DEFAULT_LANGUAGE = "en";
