import { Resend } from "resend";

// T4 spike: find out what a real inbound email looks like. Logs key names and sizes only, never email content.
// T6 turns this into the real intake route.
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

  const data = event.data as unknown as Record<string, unknown>;
  console.log("inbound: verified", {
    type: event.type,
    topLevelKeys: Object.keys(event),
    dataKeys: Object.keys(data),
    headerNames: [...request.headers.keys()].filter((h) => h.startsWith("svix-")),
  });

  if (event.type === "email.received") {
    const { data: email, error } = await resend.emails.receiving.get(data.email_id as string);
    if (error) {
      console.error("inbound: fetch of received email failed", { name: error.name, statusCode: error.statusCode });
    } else {
      console.log("inbound: fetched email", {
        keys: Object.keys(email),
        textIsNull: email.text === null,
        textChars: email.text?.length ?? 0,
        htmlChars: email.html?.length ?? 0,
        hasMessageId: Boolean(email.message_id),
        headerNames: Object.keys(email.headers ?? {}),
        webhookMessageIdMatches: email.message_id === data.message_id,
      });
    }
  }

  return new Response("ok");
}
