import { Resend } from "resend";
import { classifyHttp, GatewayError } from "../proposales/errors";

// The webhook carries no body, so the worker asks Resend for it. Resend returns { data, error } and does not throw.
// "cid" keeps inline images as short references instead of huge base64 blobs inside the html.
// ponytail: no request timeout here (the SDK has none). The row lease covers a hung call; add an AbortSignal if it happens.
export async function fetchEmailBody(emailId: string): Promise<{ text: string | null; html: string | null }> {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.receiving.get(emailId, { html_format: "cid" });
  if (error) {
    // statusCode null means the request never got an HTTP answer: a network problem, worth retrying.
    throw new GatewayError(error.statusCode === null ? { kind: "retryable", reason: "network" } : classifyHttp(error.statusCode));
  }
  return { text: data.text, html: data.html };
}
