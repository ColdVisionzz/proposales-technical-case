import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, test } from "vitest";

const dir = join(__dirname, "..", "fixtures", "proposales");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

// The whole OpenAPI file is registered as one schema, so "openapi#/components/..." references resolve inside it.
// strict: false because OpenAPI 3.0 has keywords (example, ...) that plain JSON Schema does not know.
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addFormat("int64", true); // OpenAPI-only format, nothing to check
ajv.addSchema(read(join(dir, "openapi.json")), "openapi");

const pointer = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");
const response = (path: string, method: string, status: number) =>
  `openapi#/paths/${pointer(path)}/${method}/responses/${status}/content/application~1json/schema`;
const component = (name: string) => `openapi#/components/schemas/${name}`;
const errorBody = component("ErrorResponse");

// Every synthetic fixture and the schema it must satisfy.
const fixtures: Record<string, string> = {
  "companies.200.json": response("/v3/companies", "get", 200),
  "content.200.json": response("/v3/content", "get", 200),
  "create-proposal.request.json": component("CreateProposalRequest"),
  "create-proposal.200.json": component("ProposalMutationResponse"),
  "search-by-data.200.json": response("/v3/proposal-search", "get", 200),
  "search-by-recipient.200.json": response("/v3/proposal-search", "get", 200),
  "error.400.json": errorBody,
  "error.401.json": errorBody,
  "error.429.json": errorBody,
  "error.500.json": errorBody,
};

// Where the live API is known to break its own spec (seen by the probe, 2026-10-19). Only these exact fields are
// forgiven, so a new disagreement still fails.
const specDeviations: Record<string, string[]> = {
  "companies.200.json": ["/timezone", "/website_url"], // timezone is null and website_url is "" for a new account
};

const validate = (file: string, data: unknown) => {
  const check = ajv.compile({ $ref: fixtures[file] });
  check(data);
  const allowed = specDeviations[file] ?? [];
  const errors = (check.errors ?? []).filter((e) => !allowed.some((a) => e.instancePath.endsWith(a)));
  return { ok: errors.length === 0, errors: ajv.errorsText(errors) };
};

describe("synthetic Proposales fixtures match the OpenAPI file", () => {
  test.each(Object.keys(fixtures))("%s", (file) => {
    const result = validate(file, read(join(dir, "synthetic", file)));
    expect(result.ok, result.errors).toBe(true);
  });

  test("every .json file in synthetic/ has a schema above", () => {
    const onDisk = readdirSync(join(dir, "synthetic")).filter((f) => f.endsWith(".json"));
    expect(onDisk.sort()).toEqual(Object.keys(fixtures).sort());
  });

  // A validator that accepts everything proves nothing, so show that it can fail.
  test("a fixture with a missing required field is rejected", () => {
    const broken = read(join(dir, "synthetic", "create-proposal.request.json"));
    delete broken.language;
    expect(validate("create-proposal.request.json", broken).ok).toBe(false);
  });

  test("a fixture with a wrong value is rejected", () => {
    const broken = read(join(dir, "synthetic", "search-by-data.200.json"));
    broken.data[0].status = "pending";
    expect(validate("search-by-data.200.json", broken).ok).toBe(false);
  });
});

// What the live API really returned (npm run probe). The same schemas apply: if the API drifts from the spec, this fails.
const realDir = join(dir, "real");
const realFixtures: Record<string, string> = {
  ...fixtures,
  "create-minimal.request.json": fixtures["create-proposal.request.json"],
  "create-proposal-productids.request.json": fixtures["create-proposal.request.json"],
  "create-minimal.200.json": fixtures["create-proposal.200.json"],
  "create-proposal-duplicate.200.json": fixtures["create-proposal.200.json"],
  "create-proposal-productids.200.json": fixtures["create-proposal.200.json"],
  "search-by-data-after-duplicate.200.json": fixtures["search-by-data.200.json"],
};

describe.skipIf(!existsSync(realDir))("real Proposales fixtures match the OpenAPI file", () => {
  const files = existsSync(realDir) ? readdirSync(realDir).filter((f) => f.endsWith(".json") && realFixtures[f]) : [];
  test.each(files)("%s", (file) => {
    const check = ajv.compile({ $ref: realFixtures[file] });
    check(read(join(realDir, file)));
    const allowed = specDeviations[file] ?? [];
    const errors = (check.errors ?? []).filter((e) => !allowed.some((a) => e.instancePath.endsWith(a)));
    expect(errors.length, ajv.errorsText(errors)).toBe(0);
  });
});
