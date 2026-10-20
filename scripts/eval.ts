// Runs every sample in fixtures/enquiries through extract(), validate() and decide(), scores the result against the
// sample's `expect`, prints pass or fail per field and a summary rate, and saves fixtures/enquiries/results.md.
// Usage: npm run eval [-- model-id ...]   (no ids: the default model). Calls the real model: run it by hand, never in CI.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decide } from "../lib/extraction/decide";
import { extract, DEFAULT_MODEL, PROMPT_VERSION, type EmailInput } from "../lib/extraction/extract";
import { FIELDS, score, type Expect, type Field } from "../lib/extraction/score";
import { validate } from "../lib/extraction/validate";
import { loadDotEnv } from "../lib/db/env";

const root = join(__dirname, "..", "fixtures");
// Fixed so relative dates ("next Friday", "12 December") resolve the same way on every run. A Wednesday.
const EVAL_TODAY = "2026-11-04";
const QUOTE_MISS = "The words the model quoted";

type Sample = EmailInput & { from: string; expect: Expect };
const pct = (pass: number, total: number) => (total ? `${Math.round((100 * pass) / total)}% (${pass}/${total})` : "-");

// The gateway's free tier allows 5 requests a minute. On a 429, wait out the window and try again (3 tries).
// ponytail: matches the error text, since the SDK's error class is not worth importing for a script.
async function withRateLimitWait<T>(call: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await call();
    } catch (error) {
      if (tries >= 3 || !/rate limit|429/i.test(String(error instanceof Error ? error.message : error))) throw error;
      console.log("      rate limited, waiting 65 s");
      await new Promise((resolve) => setTimeout(resolve, 65_000));
    }
  }
}

async function main() {
  loadDotEnv();
  const catalog = JSON.parse(readFileSync(join(root, "catalog.sample.json"), "utf8")).data;
  const models = process.argv.slice(2);
  if (models.length === 0) models.push(process.env.EXTRACTION_MODEL ?? DEFAULT_MODEL);
  const files = readdirSync(join(root, "enquiries")).filter((f) => f.endsWith(".json")).sort();
  const report = [`# Eval results\n`, `Prompt ${PROMPT_VERSION}, today fixed at ${EVAL_TODAY}, ${files.length} samples, run ${new Date().toISOString()}.\n`];

  for (const model of models) {
    const totals = Object.fromEntries(FIELDS.map((f) => [f, { pass: 0, total: 0 }])) as Record<Field, { pass: number; total: number }>;
    const rows: string[] = [];
    let ms = 0, tokens = 0, quoteMisses = 0, casesPassed = 0, errors = 0;
    console.log(`\n=== ${model} ===`);

    for (const file of files) {
      const name = file.replace(".json", "");
      const sample = JSON.parse(readFileSync(join(root, "enquiries", file), "utf8")) as Sample;
      let scores: ReturnType<typeof score>;
      let note = "";
      let errored = false;
      try {
        const result = await withRateLimitWait(() => extract({ subject: sample.subject, body: sample.body, sender: sample.from }, catalog, EVAL_TODAY, model));
        ms += result.meta.ms;
        tokens += (result.meta.inputTokens ?? 0) + (result.meta.outputTokens ?? 0);
        if (result.status === "ok") {
          const v = validate(result.extraction, sample, catalog, EVAL_TODAY);
          quoteMisses += v.flags.filter((f) => f.message.startsWith(QUOTE_MISS)).length;
          scores = score(sample.expect, v, decide(v).outcome);
        } else {
          scores = score(sample.expect, null, "invalid");
          note = "invalid output";
        }
      } catch (error) {
        // A provider failure says nothing about extraction quality: report it, keep it out of the rates.
        errored = true;
        scores = {};
        note = `provider error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 120);
      }

      const wrong = Object.entries(scores).filter(([, s]) => !s.pass);
      for (const [field, s] of Object.entries(scores)) {
        totals[field as Field].total++;
        if (s.pass) totals[field as Field].pass++;
      }
      if (errored) errors++;
      else if (wrong.length === 0) casesPassed++;
      const detail = wrong.map(([f, s]) => `${f}: expected ${JSON.stringify(s.expected)}, got ${JSON.stringify(s.got)}`);
      const label = errored ? "ERROR" : wrong.length ? "FAIL" : "pass";
      console.log(`${label}  ${name}${note ? ` (${note})` : ""}${detail.length ? `\n      ${detail.join("\n      ")}` : ""}`);
      rows.push(`| ${name} | ${label} | ${note || detail.join("; ") || ""} |`);
    }

    const table = FIELDS.map((f) => `| ${f} | ${pct(totals[f].pass, totals[f].total)} |`);
    const scored = files.length - errors;
    const summary = `Samples fully correct: ${pct(casesPassed, scored)}${errors ? `, ${errors} sample(s) not scored (provider error)` : ""}. Quotes not found in the email: ${quoteMisses}. Average ${(ms / Math.max(scored, 1) / 1000).toFixed(1)} s and ${Math.round(tokens / Math.max(scored, 1))} tokens per sample.`;
    console.log(`\n${FIELDS.map((f) => `${f} ${pct(totals[f].pass, totals[f].total)}`).join("  |  ")}\n${summary}`);
    report.push(`## ${model}\n`, `| Field | Pass rate |\n| --- | --- |\n${table.join("\n")}\n`, `${summary}\n`, `| Sample | Result | Detail |\n| --- | --- | --- |\n${rows.join("\n")}\n`);
  }
  writeFileSync(join(root, "enquiries", "results.md"), report.join("\n"));
  console.log("\nSaved fixtures/enquiries/results.md");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
