import { describe, expect, it } from "vitest";
import { mailtoHref, qrPath } from "@/lib/dashboard/qr";

describe("demo QR", () => {
  it("opens a new email to the address with a subject", () => {
    expect(mailtoHref("demo@x.app")).toBe("mailto:demo@x.app?subject=Group%20booking%20enquiry");
  });

  it("draws a square code with dark modules", () => {
    const { size, d } = qrPath(mailtoHref("demo@x.app"));
    expect(size).toBeGreaterThanOrEqual(21);
    expect(d.startsWith("M")).toBe(true);
    expect(qrPath(mailtoHref("demo@x.app")).d).toBe(d);
  });
});
