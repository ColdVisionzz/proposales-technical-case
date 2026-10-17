import { Resend } from "resend";
import { insertEnquiry } from "@/lib/db/enquiries";

// Real email intake. The webhook carries no body, so we store the row now and the worker fetches the body later.
export async function POST(request: Request) {
  const raw = await request.text(); // must be the raw text, the signature breaks on re-serialised JSON
  const resend = new Resend(process.env.RESEND_API_KEY);

  let event;
  try {
    event = resend.webhooks.verify({
      payload: raw,
      headers: {
        id: request.headers.get("svix-id") ?? "",
        timestamp: request.headers.get("svix-timestamp") ?? "",
        signature: request.headers.get("svix-signature") ?? "",
      },
      webhookSecret: process.env.EMAIL_WEBHOOK_SECRET ?? "",
    });
  } catch {
    console.warn("inbound: bad signature", { bodyBytes: raw.length });
    return new Response("invalid signature", { status: 401 });
  }

  // Resend sends many event types to this URL. 200 tells it we got the event and it should not retry.
  if (event.type !== "email.received") {
    console.log("inbound: ignored event", { type: event.type });
    return new Response("ignored");
  }

  const { email_id, message_id, from, subject } = event.data;
  try {
    const { id, created } = await insertEnquiry({
      messageId: message_id,
      source: "email",
      emailId: email_id,
      subject,
      sender: from,
    });
    console.log("inbound: stored", { id, created });
    return Response.json({ id, created });
  } catch (err) {
    // Not 200: the email is not stored, so Resend must retry the delivery.
    console.error("inbound: insert failed", { message: err instanceof Error ? err.message : String(err) });
    return new Response("storage error", { status: 500 });
  }
}
