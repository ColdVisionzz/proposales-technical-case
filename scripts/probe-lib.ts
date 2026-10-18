// Small pure helpers for the probe. Kept apart from the script so tests can use them without sending any request.

// Replace every secret with REDACTED. Applied to everything before it is written to disk, so a saved fixture can never
// contain the API key or the account's inbox token, even by accident.
export function redact(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("REDACTED");
  }
  return out;
}

// The "shape" of a JSON value: every path with the type found there, e.g. "$.data[].id:number".
// Values are ignored on purpose. Two answers with the same shape agree, whatever the ids and names are.
export function shape(value: unknown, path = "$", out = new Set<string>()): Set<string> {
  if (value === null) out.add(`${path}:null`);
  else if (Array.isArray(value)) {
    out.add(`${path}:array`);
    for (const item of value) shape(item, `${path}[]`, out);
  } else if (typeof value === "object") {
    out.add(`${path}:object`);
    for (const [key, item] of Object.entries(value)) shape(item, `${path}.${key}`, out);
  } else out.add(`${path}:${typeof value}`);
  return out;
}

// Where a real answer and its synthetic twin disagree. The real one wins: this list is what to fix in the synthetic
// fixture, the fake and the notes. Extra optional fields in the real answer show up as "only in real", which is expected.
export function shapeDiff(real: unknown, synthetic: unknown): { onlyReal: string[]; onlySynthetic: string[] } {
  const a = shape(real);
  const b = shape(synthetic);
  return {
    onlyReal: [...a].filter((p) => !b.has(p)).sort(),
    onlySynthetic: [...b].filter((p) => !a.has(p)).sort(),
  };
}
