import { describe, expect, test } from "vitest";
import { htmlToText, MAX_EMAIL_CHARS, readableBody, truncateEmail } from "@/lib/email/text";

describe("htmlToText", () => {
  test("keeps the words and line breaks, drops tags, scripts and styles", () => {
    const html = `<html><head><title>x</title><style>p{color:red}</style></head><body><p>Hello,</p><p>We need a <b>meeting room</b> for 24.<br>Thanks<script>alert(1)</script></p></body></html>`;
    expect(htmlToText(html)).toBe("Hello,\nWe need a meeting room for 24.\nThanks");
  });

  test("decodes entities once: &amp;lt; is the text &lt;, not a tag", () => {
    expect(htmlToText("Tom &amp; Jerry &lt;b&gt; &quot;hi&quot; caf&#233; &#x1F600; a&nbsp;b &amp;lt;")).toBe('Tom & Jerry <b> "hi" café 😀 a b &lt;');
  });

  test("collapses runs of blank lines and spaces", () => {
    expect(htmlToText("<div>a</div><div></div><div></div><div>   b   </div>")).toBe("a\n\nb");
  });

  test("a table row per line", () => {
    expect(htmlToText("<table><tr><td>Guests: 24</td></tr><tr><td>Dates: 12 March</td></tr></table>")).toBe("Guests: 24\nDates: 12 March");
  });
});

describe("readableBody", () => {
  test("prefers the plain text part", () => {
    expect(readableBody({ text: "plain", html: "<p>html</p>" })).toBe("plain");
  });

  test.each([null, "", "  \n "])("falls back to the html when the text part is %j", (text) => {
    expect(readableBody({ text, html: "<p>from html</p>" })).toBe("from html");
  });

  test("nothing at all gives an empty string, not a crash", () => {
    expect(readableBody({ text: null, html: null })).toBe("");
  });
});

describe("truncateEmail", () => {
  test("an email at the limit is untouched", () => {
    const text = "a".repeat(MAX_EMAIL_CHARS);
    expect(truncateEmail(text)).toEqual({ text, truncated: false });
  });

  test("a longer email is cut to the limit and marked", () => {
    const result = truncateEmail("b".repeat(MAX_EMAIL_CHARS + 500));
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(MAX_EMAIL_CHARS);
  });

  test("never cuts an emoji in half", () => {
    const result = truncateEmail("a".repeat(MAX_EMAIL_CHARS - 1) + "😀 and more");
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("a".repeat(MAX_EMAIL_CHARS - 1));
  });
});
