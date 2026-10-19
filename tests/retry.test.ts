import { describe, expect, test, vi } from "vitest";

// A Resend client whose call never answers, to test the body-fetch timeout.
vi.mock("resend", () => ({ Resend: class { emails = { receiving: { get: () => new Promise(() => {}) } } } }));

import { fetchEmailBody } from "../lib/email/body";
import { BACKOFF_SECONDS, exhausted, MAX_MODEL_TRIES, MAX_TRIES, retryDelaySeconds } from "../lib/pipeline/retry";
import { classifyError, GatewayError } from "../lib/proposales/errors";

const low = () => 0; // jitter pinned to its bottom: -10%
const mid = () => 0.5; // no jitter
const high = () => 1; // top: +10%

describe("retryDelaySeconds", () => {
  test("follows the SPEC steps: 30 s, 2 min, 10 min, 1 h", () => {
    expect([1, 2, 3, 4].map((tries) => retryDelaySeconds(tries, undefined, mid))).toEqual([30, 120, 600, 3600]);
  });

  test("jitter stays within plus or minus 10% of each step", () => {
    BACKOFF_SECONDS.forEach((base, i) => {
      expect(retryDelaySeconds(i + 1, undefined, low)).toBeCloseTo(Math.min(base * 0.9, 3600));
      expect(retryDelaySeconds(i + 1, undefined, high)).toBeCloseTo(Math.min(base * 1.1, 3600));
    });
  });

  test("never waits more than an hour, even past the last step", () => {
    expect(retryDelaySeconds(4, undefined, high)).toBe(3600);
    expect(retryDelaySeconds(9, undefined, high)).toBe(3600);
  });

  test("Retry-After wins when it asks for longer, and is ignored when it asks for less", () => {
    expect(retryDelaySeconds(1, 300_000, mid)).toBe(300); // 30 s backoff, server says 5 min
    expect(retryDelaySeconds(2, 5_000, mid)).toBe(120); // server says 5 s, backoff says 2 min
    expect(retryDelaySeconds(1, 99 * 3600_000, mid)).toBe(3600); // clamped
  });
});

describe("exhausted", () => {
  test("gives up at the cap: 5 tries in general, 3 for model errors", () => {
    expect([MAX_TRIES - 1, MAX_TRIES].map((t) => exhausted(t, "other"))).toEqual([false, true]);
    expect([MAX_MODEL_TRIES - 1, MAX_MODEL_TRIES].map((t) => exhausted(t, "model"))).toEqual([false, true]);
  });
});

describe("classifyError: database errors (T12 finding 4)", () => {
  test.each(["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT", "ECONNRESET", "57P01", "08006"])(
    "code %s is a retryable blip, not a permanent unknown",
    (code) => {
      expect(classifyError(Object.assign(new Error("db"), { code }))).toEqual({ kind: "retryable", reason: "database" });
    },
  );

  test("a SQL mistake of ours stays permanent", () => {
    expect(classifyError(Object.assign(new Error("syntax error"), { code: "42601" }))).toMatchObject({ kind: "permanent", reason: "unknown" });
  });
});

describe("fetchEmailBody timeout (T12 finding 6)", () => {
  test("a hung call becomes a retryable timeout instead of burning the lease", async () => {
    const failure = await fetchEmailBody("em_1", 20).catch((e) => e);
    expect(failure).toBeInstanceOf(GatewayError);
    expect(classifyError(failure)).toEqual({ kind: "retryable", reason: "timeout" });
  });
});
