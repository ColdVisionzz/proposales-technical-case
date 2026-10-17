import postgres from "postgres";
import { requireEnv } from "./env";

let sql: postgres.Sql | undefined;

// Pooled Neon URL: many short-lived functions share a few real connections.
// max 1 so a burst of function instances does not flood the pooler; prepare false because
// a transaction-mode pooler cannot track prepared statements.
export function db(): postgres.Sql {
  return (sql ??= postgres(requireEnv("DATABASE_URL"), { max: 1, prepare: false }));
}
