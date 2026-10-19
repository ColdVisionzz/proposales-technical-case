-- Small shared state every function instance must see (instances share no memory, and an env var needs a redeploy).
--   chaos              {"on": true}   the demo switch that makes Proposales calls fail; a missing row means off
--   proposales_health  {"failures": 0, "lastOkAt": ..., "lastError": ..., "auth": false, "checkedAt": ...}
CREATE TABLE settings (
  key         text        PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
