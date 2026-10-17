import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  // One at a time: the database tests share one Neon test branch and one drops tables under the other.
  test: { include: ["tests/**/*.test.ts"], fileParallelism: false },
});
