import { Resend } from "resend";
import { classifyHttp, GatewayError } from "../proposales/errors";

// The webhook carries no body, so the worker asks Resend for it. Resend returns { data, error } and does not throw.
// "cid" keeps inline images as short references instead of huge base64 blobs inside the html.
// The SDK takes no abort signal, so a hung call cannot be cancelled. The race frees the worker after the timeout and
// reports a retryable "timeout"; the abandoned request just finishes (or fails) on its own.
const FETCH_TIMEOUT_MS = 10_000;

export async function fetchEmailBody(emailId: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ text: string | null; html: string | null }> {
  const resend = new Resend(process.env.RESEND_API_KEY);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GatewayError({ kind: "retryable", reason: "timeout" })), timeoutMs);
  });
  const { data, error } = await Promise.race([resend.emails.receiving.get(emailId, { html_format: "cid" }), timeout]).finally(() => clearTimeout(timer));
  if (error) {
    // statusCode null means the request never got an HTTP answer: a network problem, worth retrying.
    throw new GatewayError(error.statusCode === null ? { kind: "retryable", reason: "network" } : classifyHttp(error.statusCode));
  }
  return { text: data.text, html: data.html };
}
