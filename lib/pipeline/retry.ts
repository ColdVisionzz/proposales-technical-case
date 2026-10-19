// How long a failed enquiry waits, and when it gives up. Pure, so the numbers are tested without a clock or a database.

// Seconds to wait after the 1st, 2nd, 3rd and 4th failed try. A 5th failure gives up.
export const BACKOFF_SECONDS = [30, 120, 600, 3600];
export const MAX_TRIES = 5; // claims since the last manual reset, crashes included
export const MAX_MODEL_TRIES = 3; // model errors cost money, so they give up sooner
export const JITTER = 0.1; // +-10%
const MAX_WAIT_SECONDS = 3600;

// The lease a claim takes (claimEnquiry's SQL says '2 minutes'; a test keeps the two equal). After a claim the worker
// sends itself a watchdog message for just after the lease would expire: a crash runs no code, so a dead worker cannot
// ask for its own retry. A worker that finished makes the watchdog harmless, because the claim refuses it.
export const LEASE_SECONDS = 120;
export const WATCHDOG_SECONDS = LEASE_SECONDS + 10;

// Has this row used up its tries? `tries` is the count after the claim that just failed.
export function exhausted(tries: number, step: "model" | "other"): boolean {
  return tries >= (step === "model" ? MAX_MODEL_TRIES : MAX_TRIES);
}

// Wait before the next try. Backoff for this try, jittered so rows that failed together do not retry together.
// A 429's Retry-After wins when it asks for longer: never retry sooner than the server said. Never more than an hour.
// `random` is injectable so tests can pin the jitter to its two extremes.
export function retryDelaySeconds(tries: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const base = BACKOFF_SECONDS[Math.min(Math.max(tries, 1), BACKOFF_SECONDS.length) - 1];
  const jittered = base * (1 - JITTER + 2 * JITTER * random());
  const asked = retryAfterMs === undefined ? 0 : retryAfterMs / 1000;
  return Math.min(Math.max(jittered, asked), MAX_WAIT_SECONDS);
}
