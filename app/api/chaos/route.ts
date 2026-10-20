import { bearerMatches } from "@/lib/auth";
import { writeChaos } from "@/lib/db/settings";

// The demo switch: POST { "on": true | false }. With it on, every Proposales call fails with a retryable error until it is
// switched off. Protected by CRON_SECRET and has no UI (a presenter tool). Fails closed when the secret is unset.
export async function POST(request: Request) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  const input = await request.json().catch(() => null);
  if (typeof input?.on !== "boolean") return Response.json({ error: "on must be true or false" }, { status: 400 });
  try {
    await writeChaos(input.on);
  } catch (err) {
    console.error("chaos: write failed", { message: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "could not save the switch" }, { status: 500 });
  }
  return Response.json({ on: input.on });
}
