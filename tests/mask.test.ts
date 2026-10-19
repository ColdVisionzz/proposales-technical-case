import { describe, expect, test } from "vitest";
import { maskDeep, maskEmails } from "../lib/db/mask";

describe("maskEmails", () => {
  test("keeps the first letters and the last domain label", () => {
    expect(maskEmails("anna.berg@mail.acme.co.uk")).toBe("a***@m***.uk");
    expect(maskEmails("a@b.se")).toBe("a***@b***.se");
  });

  test("keeps the display name and the surrounding text", () => {
    expect(maskEmails("Anna Berg <anna@acme.com>")).toBe("Anna Berg <a***@a***.com>");
    expect(maskEmails("Reply to anna@acme.com, or bo+x@acme.com.")).toBe("Reply to a***@a***.com, or b***@a***.com.");
  });

  test("handles non-ASCII names and hosts", () => {
    expect(maskEmails("åsa.öberg@hotell-väst.se")).toBe("å***@h***.se");
  });

  test("masking twice changes nothing, and text without an address is untouched", () => {
    const once = maskEmails("x@y.com");
    expect(maskEmails(once)).toBe(once);
    expect(maskEmails("30 guests @ 5 pm")).toBe("30 guests @ 5 pm");
  });
});

describe("maskDeep", () => {
  test("masks every string at any depth and leaves the shape", () => {
    const input = { a: "x@y.com", n: 3, ok: true, none: null, list: [{ evidence: "write to boss@acme.com" }, 7] };
    expect(maskDeep(input)).toEqual({ a: "x***@y***.com", n: 3, ok: true, none: null, list: [{ evidence: "write to b***@a***.com" }, 7] });
  });
});
