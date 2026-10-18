// The one place that decides whether an external failure is worth retrying.
// Nothing here stores anything: the pipeline reads the Failure and writes status, attempts,
// next_attempt_at and last_error (T14).
//
// What goes wrong                      -> Failure
// ------------------------------------------------------------------------------------------
// HTTP 429                             -> retryable "rate_limited", honours Retry-After
// HTTP 5xx                             -> retryable "upstream_<status>"
// Timeout (AbortError, TimeoutError)   -> retryable "timeout"
// Dropped connection ("fetch failed")  -> retryable "network"
// HTTP 401 / 403                       -> permanent "auth", loud (wrong or revoked key)
// Any other 4xx (400, 404, 422, ...)   -> permanent "bad_request_<status>"
// Anything we do not recognise         -> permanent "unknown" (a bug in our code, retrying hides it)

export type Failure =
  | { kind: "retryable"; reason: string; retryAfterMs?: number }
  | { kind: "permanent"; reason: string; loud?: boolean };

// Gateways throw this and nothing else. A thrown error cannot be forgotten the way an ignored
// `{ ok: false }` result can.
export class GatewayError extends Error {
  constructor(
    readonly failure: Failure,
    options?: ErrorOptions,
  ) {
    super(`${failure.kind}: ${failure.reason}`, options);
    this.name = "GatewayError";
  }
}

// Retry-After is either whole seconds or an HTTP date. Garbage gives undefined, never a throw.
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function classifyHttp(status: number, retryAfter?: string | null): Failure {
  if (status === 429) return { kind: "retryable", reason: "rate_limited", retryAfterMs: parseRetryAfter(retryAfter) };
  if (status >= 500) return { kind: "retryable", reason: `upstream_${status}` };
  if (status === 401 || status === 403) return { kind: "permanent", reason: "auth", loud: true };
  return { kind: "permanent", reason: `bad_request_${status}` };
}

// For anything that was thrown: a GatewayError, a timeout, a network error, or a bug.
export function classifyError(error: unknown): Failure {
  if (error instanceof GatewayError) return error.failure;
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return { kind: "retryable", reason: "timeout" };
    // Node's fetch reports a dropped connection as TypeError("fetch failed"). Other TypeErrors are our bugs.
    if (error instanceof TypeError && error.message === "fetch failed") return { kind: "retryable", reason: "network" };
  }
  return { kind: "permanent", reason: "unknown" };
}
