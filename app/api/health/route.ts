import { withChaos } from "@/lib/pipeline/chaos";
import { getGateway } from "@/lib/pipeline/gateway";
import { checkHealth } from "@/lib/pipeline/health";

// Is Proposales reachable? Read-only for callers: the answer is the last ping, refreshed at most once a minute
// (see checkHealth). No secret: it only says up, down or key-problem, and the ping rate is capped by the database.
export async function GET() {
  try {
    return Response.json(await checkHealth(withChaos(getGateway())), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("health: failed", { message: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "health check failed" }, { status: 500 });
  }
}
