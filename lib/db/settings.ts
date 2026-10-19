import { db } from "./client";

// ---- the chaos switch ------------------------------------------------------------------------------------------------

export async function readChaos(): Promise<boolean> {
  const [row] = await db()`SELECT value FROM settings WHERE key = 'chaos'`;
  return row?.value?.on === true; // no row means off
}

export async function writeChaos(on: boolean): Promise<void> {
  await db()`
    INSERT INTO settings (key, value) VALUES ('chaos', ${db().json({ on })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

// ---- Proposales health (written by pings, read by the dashboard) ----------------------------------------------------

export type HealthRow = {
  failures: number; // failed pings in a row; one success resets it
  checkedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  auth: boolean; // the last failure was 401/403: the key is wrong or revoked
};

export async function readHealth(): Promise<HealthRow | null> {
  const [row] = await db()`SELECT value FROM settings WHERE key = 'proposales_health'`;
  return row ? (row.value as HealthRow) : null;
}

// Decides which function gets to ping: one conditional statement, like the claim. The winner gets true; everyone else
// (the check is fresh, or another function just took the slot) gets false and only reads. A dashboard that polls every
// 2 s therefore causes at most one ping per interval, however many people look at it.
export async function claimHealthCheck(everySeconds: number): Promise<boolean> {
  const rows = await db()`
    INSERT INTO settings (key, value)
    VALUES ('proposales_health', ${db().json({ failures: 0, checkedAt: new Date().toISOString(), lastOkAt: null, lastError: null, auth: false })})
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_set(settings.value, '{checkedAt}', to_jsonb(now())), updated_at = now()
      WHERE settings.value->>'checkedAt' IS NULL
         OR (settings.value->>'checkedAt')::timestamptz < now() - make_interval(secs => ${everySeconds})
    RETURNING key`;
  return rows.length > 0;
}

// One statement each, so two results arriving together cannot lose a count.
export async function saveHealthOk(): Promise<void> {
  await db()`
    UPDATE settings
    SET value = value || jsonb_build_object('failures', 0, 'lastOkAt', now(), 'lastError', NULL, 'auth', false), updated_at = now()
    WHERE key = 'proposales_health'`;
}

export async function saveHealthFailure(reason: string, auth: boolean): Promise<void> {
  await db()`
    UPDATE settings
    SET value = value || jsonb_build_object('failures', COALESCE((value->>'failures')::int, 0) + 1, 'lastError', ${reason}::text, 'auth', ${auth}::boolean),
        updated_at = now()
    WHERE key = 'proposales_health'`;
}
