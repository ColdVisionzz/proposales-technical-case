"use client";

import { useState } from "react";
import type { EnquiryDetail } from "@/lib/db/enquiry-views";
import { emptyExtraction, extractionSchema, type Extraction } from "@/lib/extraction/schema";

type Kind = "text" | "number" | "date";
const FIELDS: ReadonlyArray<readonly [string, keyof Extraction & string, Kind]> = [
  ["Contact", "contactName", "text"],
  ["Company", "company", "text"],
  ["Event", "eventType", "text"],
  ["Start", "startDate", "date"],
  ["End", "endDate", "date"],
  ["Guests", "guests", "number"],
  ["Rooms", "rooms", "number"],
  ["Nights", "nights", "number"],
  ["Language", "language", "text"],
  ["Budget", "budget", "text"],
  ["Special requests", "specialRequests", "text"],
];
const REQUIRED = ["startDate", "guests"]; // without these there is no draft, so the button stays blocked

type Values = Record<string, string>; // every field as text; products as sorted ids joined by commas
type Current = { version: number; extracted: unknown };
type LinkProps = (key: string) => Record<string, unknown>;

const parse = (extracted: unknown): Extraction => {
  const r = extractionSchema.safeParse(extracted);
  return r.success ? r.data : emptyExtraction;
};
const valuesOf = (x: Extraction): Values => ({
  ...Object.fromEntries(FIELDS.map(([, key]) => [key, x[key as "guests"].value === null ? "" : String(x[key as "guests"].value)])),
  products: x.products.map((p) => p.variationId).sort((a, b) => a - b).join(","),
});

// The review form for a needs_review row. It keeps its own state, so the 2 s poll never resets what someone is typing.
// `seen` is what the editor last reconciled with the server (values and version); `draft` holds only the fields the person
// changed. A save sends only those, with the version in `seen`. If someone saved first the server answers 409, and the
// screen keeps the typing and asks "yours or theirs" only for fields both people changed.
export function ReviewEditor({ detail, names, link }: { detail: EnquiryDetail; names: Map<number, string> | null; link: LinkProps }) {
  const [seen, setSeen] = useState(() => ({ version: detail.version, values: valuesOf(parse(detail.extracted)) }));
  const [draft, setDraft] = useState<Values>({});
  const [collisions, setCollisions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [released, setReleased] = useState(false);

  const value = (key: string) => draft[key] ?? seen.values[key];
  const dirty = Object.keys(draft).filter((key) => draft[key] !== seen.values[key]);
  const label = (key: string) => FIELDS.find(([, k]) => k === key)?.[0] ?? (key === "products" ? "Products" : key);
  const shown = (key: string, text: string) =>
    key === "products" ? (text ? text.split(",").map((id) => names?.get(Number(id)) ?? `product #${id}`).join(", ") : "none") : text || "not stated";

  // Someone else saved first (a 409, or the banner): adopt their version, keep my typing, and only the fields we both
  // changed to different values need a choice.
  function reconcile(current: Current) {
    const theirs = valuesOf(parse(current.extracted));
    setCollisions(dirty.filter((key) => theirs[key] !== seen.values[key] && theirs[key] !== draft[key]));
    setSeen({ version: current.version, values: theirs });
    setNote("Someone else saved first. Your typing is kept. Fields you both changed need a choice below.");
  }

  // "Keep mine" leaves the typing in place; "Use theirs" drops it so the field shows the other person's value.
  function resolve(key: string, useTheirs: boolean) {
    if (useTheirs) setDraft(Object.fromEntries(Object.entries(draft).filter(([k]) => k !== key)));
    setCollisions(collisions.filter((k) => k !== key));
  }

  async function send(path: "" | "/create-anyway", body: unknown, method: "PATCH" | "POST") {
    setBusy(true);
    setNote(null);
    setProblems([]);
    try {
      const res = await fetch(`/api/enquiries/${detail.id}${path}`, { method, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json as { version: number };
      if (res.status === 409 && json.current?.status === "needs_review") reconcile(json.current);
      else if (res.status === 409) setNote("This enquiry has already moved on, so nothing was changed.");
      else if (res.status === 422) setProblems(json.problems ?? []);
      else setNote("Could not save. Try again in a moment.");
    } catch {
      setNote("Could not reach the server. Try again in a moment.");
    } finally {
      setBusy(false);
    }
    return null;
  }

  async function save() {
    const changes: Record<string, unknown> = {};
    for (const key of dirty) {
      const text = draft[key].trim();
      const kind = FIELDS.find(([, k]) => k === key)?.[2];
      if (key === "products") changes.products = text ? text.split(",").map(Number) : [];
      else if (text === "") changes[key] = null;
      else if (kind === "number") {
        if (!Number.isInteger(Number(text))) return setNote(`${label(key)} must be a whole number.`);
        changes[key] = Number(text);
      } else changes[key] = text;
    }
    const ok = await send("", { version: seen.version, changes }, "PATCH");
    if (ok) {
      setSeen({ version: ok.version, values: { ...seen.values, ...draft } });
      setDraft({});
    }
  }

  async function release() {
    if (await send("/create-anyway", { version: seen.version }, "POST")) setReleased(true);
  }

  const toggle = (id: number) => {
    const ids = new Set(value("products") ? value("products").split(",").map(Number) : []);
    if (!ids.delete(id)) ids.add(id);
    setDraft({ ...draft, products: [...ids].sort((a, b) => a - b).join(",") });
  };
  const missing = REQUIRED.filter((key) => !value(key).trim());
  const input = "w-full rounded-md border bg-background px-2 py-1 text-right text-sm";

  return (
    <section>
      <h3 className="label mb-3 text-sm font-semibold">Fill in what is missing</h3>

      {detail.version > seen.version && collisions.length === 0 && (
        <p role="status" className="mb-3 rounded-lg border border-warn px-3 py-2 text-sm">
          Someone else saved changes.{" "}
          <button type="button" className="underline" onClick={() => reconcile(detail)}>
            Load them and keep my typing
          </button>
        </p>
      )}

      <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {FIELDS.map(([name, key, kind]) => {
          const empty = !value(key).trim();
          return (
            <div key={key} className={`row-ev px-4 py-2.5 ${empty && REQUIRED.includes(key) ? "bg-warn/10" : ""}`} {...link(key)}>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-sm text-muted">
                  <label htmlFor={`f-${key}`}>{name}</label>
                  {REQUIRED.includes(key) && <span className="ml-1 text-xs text-warn">needed</span>}
                </dt>
                <dd className="w-1/2">
                  <input
                    id={`f-${key}`}
                    type={kind === "number" ? "number" : kind}
                    inputMode={kind === "number" ? "numeric" : undefined}
                    value={value(key)}
                    placeholder={key === "language" ? "en" : "Not stated"}
                    maxLength={key === "language" ? 2 : undefined}
                    disabled={busy || released}
                    onChange={(ev) => setDraft({ ...draft, [key]: ev.target.value })}
                    className={`${input} ${empty ? "border-warn" : "border-line"} ${dirty.includes(key) ? "font-semibold" : ""}`}
                  />
                </dd>
              </div>
              {collisions.includes(key) && <Collision label={name} mine={shown(key, draft[key])} theirs={shown(key, seen.values[key])} onMine={() => resolve(key, false)} onTheirs={() => resolve(key, true)} />}
            </div>
          );
        })}
        <div className="px-4 py-2.5">
          <dt className="text-sm text-muted">Products asked for</dt>
          <dd className="mt-1 space-y-1">
            {names === null && <span className="text-sm text-muted">The product list is not loaded.</span>}
            {names &&
              [...names].map(([id, title]) => (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" disabled={busy || released} checked={value("products").split(",").includes(String(id))} onChange={() => toggle(id)} />
                  {title}
                </label>
              ))}
          </dd>
          {collisions.includes("products") && <Collision label="Products" mine={shown("products", draft.products)} theirs={shown("products", seen.values.products)} onMine={() => resolve("products", false)} onTheirs={() => resolve("products", true)} />}
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={busy || released || dirty.length === 0 || collisions.length > 0} className="press rounded-full border border-line-strong px-4 py-2 text-sm font-medium disabled:opacity-50">
          {busy ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={release} disabled={busy || released || dirty.length > 0 || missing.length > 0} className="press rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50">
          {released ? "Back in the queue" : "Create draft anyway"}
        </button>
      </div>
      <p className="mt-2 text-sm text-muted">
        {dirty.length > 0 ? "Save your changes first." : missing.length > 0 ? `Still needed: ${missing.map(label).join(", ")}.` : released ? "" : "Creates a draft in Proposales from these values. Nothing is sent to the customer."}
      </p>
      {note && (
        <p role="status" className="mt-2 text-sm">
          {note}
        </p>
      )}
      {problems.length > 0 && (
        <ul role="alert" className="mt-2 list-disc space-y-1 pl-5 text-sm text-bad">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Collision({ label, mine, theirs, onMine, onTheirs }: { label: string; mine: string; theirs: string; onMine: () => void; onTheirs: () => void }) {
  return (
    <div role="group" aria-label={`${label}: you and someone else changed this`} className="mt-2 rounded-lg border border-warn p-3 text-sm">
      <p>
        You both changed <strong>{label}</strong>. Yours: <strong>{mine}</strong>. Theirs: <strong>{theirs}</strong>.
      </p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={onMine} className="press rounded-full border border-line-strong px-3 py-1">
          Keep mine
        </button>
        <button type="button" onClick={onTheirs} className="press rounded-full border border-line-strong px-3 py-1">
          Use theirs
        </button>
      </div>
    </div>
  );
}
