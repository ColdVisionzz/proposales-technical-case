import { loadDotEnv, requireEnv } from "../lib/db/env";
import { migrate } from "../lib/db/migrate";

loadDotEnv();
// Unpooled URL: a transaction must stay on one real connection.
const applied = await migrate(requireEnv("DATABASE_URL_UNPOOLED"));
console.log(applied.length ? `applied: ${applied.join(", ")}` : "nothing to apply");
