import { createHash } from "node:crypto";
import { parseSender } from "./draft";

// How long an earlier draft counts as "the same enquiry". After that, the same text is a new enquiry.
export const DUPLICATE_WINDOW_DAYS = 7;

// A person sending the same text again gets a new Message-ID, so message_id cannot catch it. The sender address plus the
// body can: same person, same words. Case and spacing are ignored, so a mail client re-wrapping lines does not matter.
// Any other change to the words (a new date, one more guest) gives a different fingerprint, which is right: that is a
// changed request, not a repeat. No sender address, no fingerprint (null): we cannot tell whose text it is.
export function fingerprintOf(sender: string | null, body: string): string | null {
  const address = parseSender(sender).email?.toLowerCase();
  const text = body.toLowerCase().replace(/\s+/g, " ").trim();
  if (!address || !text) return null;
  return createHash("sha256").update(`${address}\n${text}`).digest("hex");
}
