import qrcode from "qrcode-generator";

const SUBJECT = "Group booking enquiry";

// The link the QR code and the phone button both open: a new email to the demo inbox with a subject already filled in.
export function mailtoHref(address: string): string {
  return `mailto:${address}?subject=${encodeURIComponent(SUBJECT)}`;
}

// The QR code as one SVG path (a unit square per dark module) plus its side length, so it renders as plain JSX with no
// raw HTML. The quiet zone is left to the caller.
export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let d = "";
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
  return { size, d };
}
