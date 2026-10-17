import { loadDotEnv, requireEnv } from "../lib/db/env";
import { migrate } from "../lib/db/migrate";

async function main() {
  loadDotEnv();
  // Unpooled URL: a transaction must stay on one real connection.
  const applied = await migrate(requireEnv("DATABASE_URL_UNPOOLED"));
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "nothing to apply");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
