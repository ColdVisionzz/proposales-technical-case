import { claimHealthCheck, readHealth, saveHealthFailure, saveHealthOk, type HealthRow } from "../db/settings";
import { classifyError } from "../proposales/errors";
import type { ProposalesGateway } from "../proposales/gateway";

// Is Proposales reachable? Measured directly with a cheap call (the catalog read), not from our own traffic.
// A ping can succeed while the real create call fails, so this is a hint for the dashboard, not a guarantee.
export const CHECK_EVERY_SECONDS = 60;
export const DOWN_AFTER = 2; // failed pings in a row

export type HealthState = "unknown" | "ok" | "down" | "auth";
export type Health = { state: HealthState; lastError: string | null; lastOkAt: string | null; checkedAt: string | null };

// auth wins at once (a wrong key does not heal by itself); otherwise two failed pings in a row mean down; one success heals.
export function stateOf(row: HealthRow | null): HealthState {
  if (!row || (row.failures === 0 && !row.lastOkAt)) return "unknown"; // no ping has finished yet (the first caller is still pinging)
  if (row.auth && row.failures > 0) return "auth";
  return row.failures >= DOWN_AFTER ? "down" : "ok";
}

// Called by GET /api/health. Reads the last result; if it is stale, one caller (decided by one conditional UPDATE)
// pings first. A dashboard polling every 2 s therefore pings at most once per interval. Goes through the same gateway as
// the pipeline, so the chaos switch turns the banner on too.
export async function checkHealth(gateway: ProposalesGateway): Promise<Health> {
  if (await claimHealthCheck(CHECK_EVERY_SECONDS)) {
    try {
      await gateway.getCatalog();
      await saveHealthOk();
    } catch (error) {
      const failure = classifyError(error);
      await saveHealthFailure(failure.reason, failure.kind === "permanent" && failure.reason === "auth");
    }
  }
  const row = await readHealth();
  return { state: stateOf(row), lastError: row?.lastError ?? null, lastOkAt: row?.lastOkAt ?? null, checkedAt: row?.checkedAt ?? null };
}
