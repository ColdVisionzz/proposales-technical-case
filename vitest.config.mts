import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  // One at a time: the database tests share one Neon test branch and one drops tables under the other.
  // The database tests talk to a remote Neon branch. Opening several fresh connections after an idle spell can take
  // longer than vitest's 5 s default, which made the parallel-claim test fail once without anything being wrong.
  test: { include: ["tests/**/*.test.ts"], fileParallelism: false, testTimeout: 20_000, hookTimeout: 30_000 },
});
