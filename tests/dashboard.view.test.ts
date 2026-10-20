import { describe, expect, test } from "vitest";
import { AI_AT, booking, highlight, stageIndex, explainError, lineText, niceDates, pipeView, timeTaken } from "../lib/dashboard/view";
import { clean } from "./extraction.fixtures";

const NOW = Date.parse("2026-10-19T12:00:10Z");
const base = { step: null, lastError: null, nextAttemptAt: null };

describe("pipeView", () => {
  test("processing: reading steps sit at the AI, later steps are past it", () => {
    for (const step of [null, "received", "claimed", "body_fetched"]) {
      expect(pipeView({ ...base, status: "processing", step }, NOW).at).toBe(AI_AT);
    }
    for (const step of ["extracted", "decided", "draft_created"]) {
      expect(pipeView({ ...base, status: "processing", step }, NOW).at).toBeGreaterThan(AI_AT);
    }
  });

  test("each status gets its own mood", () => {
    const mood = (status: string) => pipeView({ ...base, status }, NOW).mood;
    expect(mood("queued")).toBe("waiting");
    expect(mood("draft_created")).toBe("done");
    expect(mood("needs_review")).toBe("stopped");
    expect(mood("failed_permanent")).toBe("failed");
    expect(mood("ignored")).toBe("drained");
  });

  test("retrying shows a countdown, and 'now' once due", () => {
    const wait = pipeView({ ...base, status: "retrying", lastError: "retryable: upstream_503", nextAttemptAt: "2026-10-19T12:00:40Z" }, NOW);
    expect(wait.sub).toContain("Trying again in 30 s");
    const due = pipeView({ ...base, status: "retrying", lastError: "retryable: upstream_503", nextAttemptAt: "2026-10-19T12:00:00Z" }, NOW);
    expect(due.sub).toContain("Trying again now");
  });
});

describe("explainError", () => {
  test.each([
    ["retryable: upstream_503", "server problem"],
    ["retryable: chaos", "on purpose"],
    ["retryable: rate_limited", "slow down"],
    ["permanent: auth", "API key"],
    ["permanent: bad_request_400 (title_md is required)", "invalid"],
    ["permanent: weird_new_code", "unexpected"],
  ])("%s", (raw, text) => expect(explainError(raw)).toContain(text));

  test("gave up keeps the try count and the reason", () => {
    expect(explainError("gave up after 5 tries: retryable: upstream_502")).toBe("Gave up after 5 tries. Proposales had a server problem.");
  });

  test("never shows a raw code", () => {
    expect(explainError("permanent: bad_request_422")).not.toContain("bad_request");
    expect(explainError(null)).toContain("no details");
  });
});

describe("timeTaken", () => {
  const row = { createdAt: "2026-10-19T12:00:00Z", updatedAt: "2026-10-19T12:00:04Z" };
  test("a finished row stops at its last update, an open one runs to now", () => {
    expect(timeTaken({ ...row, status: "draft_created" }, NOW)).toBe("4 s");
    expect(timeTaken({ ...row, status: "processing" }, NOW)).toBe("10 s");
    expect(timeTaken({ ...row, status: "processing" }, NOW + 62_000)).toBe("1 min 12 s");
  });
});

describe("booking", () => {
  const withProducts = { ...clean(), products: [{ variationId: 1, confidence: 0.9, evidence: "lunch", quantity: null, quantityEvidence: null }, { variationId: 99, confidence: 0.9, evidence: "x", quantity: null, quantityEvidence: null }] };
  const names = new Map([[1, "Lunch"]]);

  test("an id that is not in the catalog is dropped", () => {
    const b = booking(withProducts, names);
    expect(b?.lines.map((l) => l.label)).toEqual(["Lunch"]);
  });

  test("lunch is one per guest per day (12-13 March: 2 days), like the real draft", () => {
    const b = booking({ ...withProducts, guests: { value: 12, confidence: 1, evidence: "12" } }, names);
    expect(b?.lines[0]).toEqual({ label: "Lunch", quantity: 24 });
  });

  test("a stated quantity is shown when it fits the booking, and ignored when it does not", () => {
    const stated = (quantity: number) => ({ ...withProducts, guests: { value: 12, confidence: 1, evidence: "12" }, products: [{ ...withProducts.products[0], quantity, quantityEvidence: "5 of us" }] });
    expect(booking(stated(5), names)?.lines[0].quantity).toBe(5);
    expect(booking(stated(500), names)?.lines[0].quantity).toBe(24);
  });

  test("an extraction stored before quantities existed still gives a card", () => {
    const old = { ...withProducts, products: [{ variationId: 1, confidence: 0.9, evidence: "lunch" }] };
    expect(booking(old, names)?.lines).toHaveLength(1);
  });

  test("without a catalog the id is shown, nothing is hidden", () => {
    expect(booking(withProducts, null)?.lines.map((l) => l.label)).toEqual(["product #1", "product #99"]);
  });

  test("unreadable extraction gives null", () => {
    expect(booking({ nope: true }, names)).toBeNull();
    expect(booking(null, names)).toBeNull();
  });

  test("niceDates", () => {
    expect(niceDates("2027-03-12", "2027-03-13")).toBe("12–13 Mar 2027");
    expect(niceDates("2027-03-30", "2027-04-02")).toBe("30 Mar – 2 Apr 2027");
    expect(niceDates("2027-03-12", null)).toBe("12 Mar 2027");
    expect(niceDates("next week", null)).toBe("next week");
  });

  test("lineText pluralises the way the mockup reads", () => {
    expect(lineText({ label: "Hotel room", quantity: 1 })).toBe("1 hotel room");
    expect(lineText({ label: "Lunch", quantity: 12 })).toBe("12 lunches");
    expect(lineText({ label: "Meeting room", quantity: 2 })).toBe("2 meeting rooms");
  });
});

describe("stageIndex", () => {
  test("every status lands on the stage the pipe shows", () => {
    const stage = (status: string, step: string | null = null) => stageIndex(pipeView({ ...base, status, step }, NOW).at);
    expect(stage("queued")).toBe(0);
    expect(stage("processing", "claimed")).toBe(1);
    expect(stage("processing", "extracted")).toBe(2);
    expect(stage("retrying")).toBe(2);
    expect(stage("failed_permanent")).toBe(2);
    expect(stage("needs_review")).toBe(1);
    expect(stage("ignored")).toBe(1);
    expect(stage("draft_created")).toBe(3);
  });
});

describe("highlight", () => {
  const marked = (body: string, items: { key: string; evidence: string | null }[]) => highlight(body, items).filter((s) => s.keys.length);

  test("marks the quote and keeps the text whole", () => {
    const body = "Hi,\nWe need 5 rooms for May.";
    const items = [{ key: "rooms", evidence: "We need 5 rooms" }];
    expect(highlight(body, items).map((s) => s.text).join("")).toBe(body);
    expect(marked(body, items)).toEqual([{ text: "We need 5 rooms", keys: ["rooms"] }]);
  });

  test("ignores case, line breaks, curly quotes and dash style", () => {
    expect(marked("we need\n5   ROOMS", [{ key: "r", evidence: "We need 5 rooms" }])[0].text).toBe("we need\n5   ROOMS");
    expect(marked("it’s a 12–13 March event", [{ key: "d", evidence: "it's a 12-13 March" }])[0].text).toBe("it’s a 12–13 March");
  });

  test("two fields on overlapping words both own the shared part", () => {
    const segs = marked("30 guests and 15 rooms", [
      { key: "guests", evidence: "30 guests and 15" },
      { key: "rooms", evidence: "15 rooms" },
    ]);
    expect(segs).toEqual([
      { text: "30 guests and ", keys: ["guests"] },
      { text: "15", keys: ["guests", "rooms"] },
      { text: " rooms", keys: ["rooms"] },
    ]);
  });

  test("a quote that is not in the email, or is empty, marks nothing", () => {
    expect(marked("hello", [{ key: "a", evidence: "goodbye" }, { key: "b", evidence: "  " }, { key: "c", evidence: null }])).toEqual([]);
  });

  test("regex characters in a quote are literal", () => {
    expect(marked("budget (approx.) 5k+", [{ key: "b", evidence: "(approx.) 5k+" }])[0].text).toBe("(approx.) 5k+");
  });
});
