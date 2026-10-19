"use client";

import { useEffect, useRef } from "react";
import type { EnquiryDetail } from "@/lib/db/enquiry-views";
import { extractionSchema } from "@/lib/extraction/schema";
import { explainError, stepLabel, timeTaken } from "@/lib/dashboard/view";
import { ArrowUpRight, Close } from "./icons";
import { RetryButton } from "./RetryButton";
import { StatusChip } from "./StatusChip";

type Props = { open: boolean; detail: EnquiryDetail | null; names: Map<number, string> | null; now: number; onClose: () => void };

const FIELDS = [
  ["Contact", "contactName"],
  ["Company", "company"],
  ["Event", "eventType"],
  ["Start", "startDate"],
  ["End", "endDate"],
  ["Guests", "guests"],
  ["Rooms", "rooms"],
  ["Nights", "nights"],
  ["Language", "language"],
  ["Budget", "budget"],
  ["Special requests", "specialRequests"],
] as const;

// Side panel on a native <dialog>: focus stays inside, Esc and the backdrop close it, and the URL follows through onClose.
export function EnquiryDrawer({ open, detail, names, now, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby="drawer-title"
      onClose={onClose}
      onClick={(ev) => {
        if (ev.target === ref.current) onClose(); // a click on the backdrop lands on the dialog itself
      }}
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-5 md:px-8">
          <div className="min-w-0">
            <h2 id="drawer-title" className="display truncate text-2xl font-semibold">
              {detail?.subject || (detail ? "(no subject)" : "Loading")}
            </h2>
            {detail && (
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
                <StatusChip status={detail.status} />
                <span className="min-w-0 truncate">{detail.sender || "unknown sender"}</span>
                <span className="num text-xs">{now ? timeTaken(detail, now) : ""}</span>
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close details" className="press -mr-2 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-background hover:text-foreground">
            <Close className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-8 overflow-y-auto px-5 py-6 md:px-8">{detail ? <Body detail={detail} names={names} /> : <p className="text-muted">Loading the enquiry…</p>}</div>
      </div>
    </dialog>
  );
}

function Callout({ tone, title, children }: { tone: "bad" | "warn"; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-background p-4" style={{ borderLeft: `3px solid var(--${tone})` }}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="label mb-3 text-sm font-semibold">{children}</h3>;
}

function Body({ detail: d, names }: { detail: EnquiryDetail; names: Map<number, string> | null }) {
  const parsed = extractionSchema.safeParse(d.extracted);
  const x = parsed.success ? parsed.data : null;
  const report = (d.flags ?? {}) as { flags?: { message: string }[]; reasons?: string[] };
  const why = [...(report.reasons ?? []), ...(report.flags ?? []).map((f) => f.message)];
  const t0 = d.events[0] ? Date.parse(d.events[0].at) : 0;

  return (
    <>
      {(d.status === "failed_permanent" || d.status === "retrying") && (
        <Callout tone="bad" title={d.status === "retrying" ? "Waiting to retry" : "Stopped with an error"}>
          <p className="mt-1 text-sm text-muted">{explainError(d.lastError)}</p>
          {d.status === "failed_permanent" && <RetryButton id={d.id} className="mt-3" />}
        </Callout>
      )}

      {why.length > 0 && d.status !== "draft_created" && (
        <Callout tone="warn" title={d.status === "needs_review" ? "Why this needs a human" : "Notes"}>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-muted">
            {why.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Callout>
      )}

      {d.proposalUrl && (
        <a href={d.proposalUrl} target="_blank" rel="noopener noreferrer" className="press inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90">
          Open proposal <ArrowUpRight className="h-4 w-4" />
        </a>
      )}

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <Heading>Original email</Heading>
          <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-background p-4 font-mono text-[13px] leading-relaxed">
            {d.body ?? "The email text has not been fetched yet."}
          </pre>
        </section>

        <section>
          <Heading>What the AI read</Heading>
          {x ? (
            <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line">
              {FIELDS.map(([label, key]) => {
                const f = x[key];
                return (
                  <div key={key} className="px-4 py-2.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-sm text-muted">{label}</dt>
                      <dd className={`text-right text-sm font-medium ${f.value === null ? "text-muted" : ""}`}>
                        {f.value === null ? "Not stated" : String(f.value)}
                        {f.value !== null && <span className="num ml-2 text-xs font-normal text-muted">{Math.round(f.confidence * 100)}%</span>}
                      </dd>
                    </div>
                    {f.value !== null && f.evidence && <p className="mt-0.5 text-sm text-muted">&ldquo;{f.evidence}&rdquo;</p>}
                  </div>
                );
              })}
              <div className="px-4 py-2.5">
                <dt className="text-sm text-muted">Products asked for</dt>
                <dd className="mt-1 space-y-2">
                  {x.products.length === 0 && <span className="text-sm text-muted">None matched the catalog</span>}
                  {x.products.map((p) => (
                    <div key={p.variationId}>
                      <span className="text-sm font-medium">{names?.get(p.variationId) ?? `product #${p.variationId}`}</span>
                      <span className="num ml-2 text-xs text-muted">{Math.round(p.confidence * 100)}%</span>
                      <p className="text-sm text-muted">&ldquo;{p.evidence}&rdquo;</p>
                    </div>
                  ))}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="rounded-xl border border-line bg-background p-4 text-sm text-muted">Nothing extracted yet.</p>
          )}
        </section>
      </div>

      <section>
        <Heading>Timeline</Heading>
        <ol className="ml-1 border-l border-line-strong">
          {d.events.map((ev, i) => (
            <li key={i} className="relative grid grid-cols-[1fr_auto] items-baseline gap-x-4 py-1.5 pl-5 text-sm">
              <span className="absolute -left-[4.5px] top-3 h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
              <span>
                <span className="font-medium">{stepLabel(ev.step)}</span>
                <span className="ml-2 text-muted">{ev.outcome}</span>
              </span>
              <span className="num text-xs text-muted">+{((Date.parse(ev.at) - t0) / 1000).toFixed(1)} s</span>
            </li>
          ))}
        </ol>
        {d.model && <p className="num mt-3 text-xs text-muted">Read by {d.model}</p>}
      </section>
    </>
  );
}
