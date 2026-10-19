"use client";

import type { EnquiryDetail, EnquirySummary } from "@/lib/db/enquiry-views";
import { booking, explainError, pipeView } from "@/lib/dashboard/view";
import { ArrowUpRight } from "./icons";
import { RetryButton } from "./RetryButton";

type Props = { enquiry: EnquirySummary; detail: EnquiryDetail | null; names: Map<number, string> | null; now: number; onOpen: () => void };

// What the draft will contain, laid out like the proposal's lines. The panel keeps one shape for every state, so nothing
// jumps when the status changes: waiting shows the same rows as placeholders, a problem shows its cause and its action.
export function ProposalPreview({ enquiry: e, detail, names, now, onOpen }: Props) {
  const { mood } = pipeView(e, now);
  const tone = mood === "failed" ? "var(--bad)" : mood === "stopped" || mood === "stalled" ? "var(--warn)" : "transparent";

  return (
    <section className="panel flex min-h-72 flex-col overflow-hidden" aria-labelledby="preview-title" style={{ borderLeft: `3px solid ${tone}` }}>
      <header className="flex items-center justify-between gap-3 border-b border-line bg-background/60 px-5 py-3.5">
        <h3 id="preview-title" className="text-sm font-semibold">
          Proposal preview
        </h3>
        {e.proposalUrl && <span className="label text-xs text-muted">Draft in Proposales</span>}
      </header>

      <div className="flex-1 px-5 py-5">
        {mood === "done" ? <Lines detail={detail} names={names} /> : mood === "failed" ? <Failed e={e} /> : mood === "stopped" ? <Stopped onOpen={onOpen} /> : mood === "drained" ? <Plain title="Nothing to book" text="No draft is made for emails that are not enquiries." /> : <Waiting />}
      </div>

      <footer className="border-t border-line px-5 py-3.5">
        {e.proposalUrl ? (
          <a href={e.proposalUrl} target="_blank" rel="noopener noreferrer" className="press inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90">
            Open proposal
            <ArrowUpRight className="h-4 w-4" />
          </a>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-4 py-2 text-sm font-medium text-muted" aria-disabled="true">
            Open proposal
          </span>
        )}
      </footer>
    </section>
  );
}

function Lines({ detail, names }: { detail: EnquiryDetail | null; names: Map<number, string> | null }) {
  const b = detail ? booking(detail.extracted, names) : null;
  if (!b || (!b.lines.length && !b.facts.length)) {
    return <p className="text-sm text-muted">{detail ? "The draft is ready. Open the proposal to see the lines." : "Loading the details…"}</p>;
  }
  const step = 90;
  return (
    <>
      {b.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
          {b.facts.map((f, i) => (
            <div key={f.label} className="line-in col-span-2 grid grid-cols-subgrid" style={{ animationDelay: `${i * 60}ms` }}>
              <dt className="text-muted">{f.label}</dt>
              <dd className="font-medium">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {b.lines.length > 0 && (
        <ul className="mt-5 divide-y divide-line border-y border-line">
          {b.lines.map((l, i) => (
            <li key={l.label} className="line-in flex items-baseline justify-between gap-4 py-2.5" style={{ animationDelay: `${(b.facts.length + i) * 60 + step}ms` }}>
              <span className="font-medium">{l.label}</span>
              <span className="num text-sm text-muted">&times; {l.quantity}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// Same rows as the finished preview, empty, so the panel keeps its size while the AI works.
function Waiting() {
  return (
    <div aria-busy="true">
      <div className="space-y-2.5" aria-hidden="true">
        {[44, 56, 36].map((w) => (
          <div key={w} className="h-3 animate-pulse rounded-full bg-line" style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className="mt-6 space-y-3.5 border-t border-line pt-4" aria-hidden="true">
        {[62, 48, 54].map((w) => (
          <div key={w} className="h-3.5 animate-pulse rounded-full bg-line" style={{ width: `${w}%` }} />
        ))}
      </div>
      <p className="mt-5 text-sm text-muted">The details and lines appear here as soon as the draft is built.</p>
    </div>
  );
}

function Failed({ e }: { e: EnquirySummary }) {
  return (
    <div>
      <h4 className="font-semibold">Could not create the draft</h4>
      <p className="mt-1.5 text-sm text-muted">{explainError(e.lastError)}</p>
      <RetryButton id={e.id} className="mt-4" />
    </div>
  );
}

function Stopped({ onOpen }: { onOpen: () => void }) {
  return (
    <div>
      <h4 className="font-semibold">Needs a human</h4>
      <p className="mt-1.5 text-sm text-muted">Something was missing or unclear, so no draft was made. Open the details to see what.</p>
      <button type="button" onClick={onOpen} className="press mt-4 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90">
        See why
      </button>
    </div>
  );
}

function Plain({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h4 className="font-semibold">{title}</h4>
      <p className="mt-1.5 text-sm text-muted">{text}</p>
    </div>
  );
}
