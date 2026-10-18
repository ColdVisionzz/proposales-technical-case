// Runs every sample in fixtures/enquiries through extract() and prints the email next to the result.
// Usage: npm run eval [-- model-id ...]   (no ids: the default model)
// Compare models by reading the output: fields right, seconds per call, tokens used.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extract, DEFAULT_MODEL, type EmailInput } from "../lib/extraction/extract";
import { loadDotEnv } from "../lib/db/env";

const root = join(__dirname, "..", "fixtures");

async function main() {
  loadDotEnv();
  const catalog = JSON.parse(readFileSync(join(root, "catalog.sample.json"), "utf8")).data;
  const models = process.argv.slice(2);
  if (models.length === 0) models.push(process.env.EXTRACTION_MODEL ?? DEFAULT_MODEL);
  const today = new Date().toISOString().slice(0, 10);

  for (const file of readdirSync(join(root, "enquiries")).filter((f) => f.endsWith(".json")).sort()) {
    const sample = JSON.parse(readFileSync(join(root, "enquiries", file), "utf8")) as EmailInput & { from: string };
    console.log(`\n${"=".repeat(80)}\n${file}\n${"=".repeat(80)}\nFrom: ${sample.from}\nSubject: ${sample.subject}\n\n${sample.body}`);
    for (const model of models) {
      try {
        const result = await extract({ subject: sample.subject, body: sample.body, sender: sample.from }, catalog, today, model);
        const { ms, inputTokens, outputTokens, attempts } = result.meta;
        console.log(`\n--- ${model}: ${result.status}, ${(ms / 1000).toFixed(1)}s, ${inputTokens} in / ${outputTokens} out tokens, ${attempts} attempt(s)`);
        console.log(JSON.stringify(result.status === "ok" ? result.extraction : result.reason, null, 2));
      } catch (error) {
        console.log(`\n--- ${model}: provider error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
