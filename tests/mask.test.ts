import { describe, expect, test } from "vitest";
import { maskDeep, maskEmails } from "../lib/db/mask";

describe("maskEmails", () => {
  test("keeps the first letter of the name and the full domain", () => {
    expect(maskEmails("anna.berg@mail.acme.co.uk")).toBe("a***@mail.acme.co.uk");
    expect(maskEmails("a@b.se")).toBe("a***@b.se");
  });

  test("keeps the display name and the surrounding text", () => {
    expect(maskEmails("Anna Berg <anna@acme.com>")).toBe("Anna Berg <a***@acme.com>");
    expect(maskEmails("Reply to anna@acme.com, or bo+x@acme.com.")).toBe("Reply to a***@acme.com, or b***@acme.com.");
  });

  test("handles non-ASCII names and hosts", () => {
    expect(maskEmails("åsa.öberg@hotell-väst.se")).toBe("å***@hotell-väst.se");
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
    expect(maskDeep(input)).toEqual({ a: "x***@y.com", n: 3, ok: true, none: null, list: [{ evidence: "write to b***@acme.com" }, 7] });
  });
});
