// Email addresses never leave the server in the clear. The dashboard's read queries run everything they return through here,
// so the browser, the network tab and the page source only ever see "a***@a***.com". The pipeline reads the database directly
// and still sees the real address, which it needs to find and create the draft.

const ADDRESS = /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

const first = (s: string) => [...s][0] ?? "";

// "anna.berg@mail.acme.co.uk" -> "a***@m***.uk": first letter of the name, first letter of the host, last label kept.
// Masked text matches no address again, so masking twice changes nothing.
export function maskEmails(text: string): string {
  return text.replace(ADDRESS, (address) => {
    const at = address.lastIndexOf("@");
    const host = address.slice(at + 1);
    return `${first(address)}***@${first(host)}***.${host.slice(host.lastIndexOf(".") + 1)}`;
  });
}

// Same for any JSON value (extracted fields, flags): every string inside is masked, the shape stays.
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskEmails(value) as T;
  if (Array.isArray(value)) return value.map(maskDeep) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)])) as T;
  return value;
}
