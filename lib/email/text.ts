// Cap on how much of one email the model reads. Roughly 5,000 tokens, which costs almost nothing,
// so the limit is about abuse, not budget. The full text stays in the database.
export const MAX_EMAIL_CHARS = 20_000;

const ENTITIES: Record<string, string> = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

// Rough HTML to text for HTML-only emails: drops scripts and styles, keeps line breaks, strips tags, decodes entities.
// Good enough to find the words of an enquiry. Not a full HTML parser.
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return stripped
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(nbsp|lt|gt|quot|apos|amp);/g, (_, name: string) => ENTITIES[name]) // one pass: "&amp;lt;" becomes "&lt;", not "<"
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The words of the email: the plain-text part if there is one, otherwise the HTML turned into text.
export function readableBody(parts: { text: string | null; html: string | null }): string {
  if (parts.text?.trim()) return parts.text;
  return parts.html ? htmlToText(parts.html) : "";
}

export function truncateEmail(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_EMAIL_CHARS) return { text, truncated: false };
  let cut = text.slice(0, MAX_EMAIL_CHARS);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1); // never end on half an emoji
  return { text: cut, truncated: true };
}
