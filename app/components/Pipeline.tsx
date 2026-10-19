"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { EnquiryDetail, EnquirySummary } from "@/lib/db/enquiry-views";
import { AI_AT, booking, explainError, lineText, pipeView } from "@/lib/dashboard/view";
import { AiMark, ArrowUpRight, Crack, Envelope } from "./icons";
import { RetryButton } from "./RetryButton";

type Props = {
  enquiry: EnquirySummary;
  detail: EnquiryDetail | null;
  names: Map<number, string> | null;
  now: number;
  onOpen: () => void;
};

// The hero: one enquiry shown as mail travelling down a pipe, right to left, from the inbox through the AI to the draft.
// Parent keys this by enquiry id, so a new enquiry starts at the inbox and slides in.
export function Pipeline({ enquiry: e, detail, names, now, onOpen }: Props) {
  const view = pipeView(e, now);
  const [at, setAt] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAt(view.at)); // one frame later, so the move is a transition and not a jump
    return () => cancelAnimationFrame(frame);
  }, [view.at]);

  const style = { "--at": at, "--ai": AI_AT, "--crack": view.at } as CSSProperties;
  return (
    <div>
      <div className="stage" data-mood={view.mood} style={style}>
        <div className="stage-in flex items-center justify-center gap-2 py-2 md:flex-col">
          <Envelope className="h-[68px] w-[92px] drop-shadow-md" />
          <span className="text-sm font-medium">Mail received</span>
        </div>

        <div className="stage-pipe pipe" aria-hidden="true">
          <div className="pipe-body">
            <div className="pipe-flow" />
          </div>
          <div className="pipe-crack">
            <Crack className="h-full w-full" />
          </div>
          <div className="pipe-packet">
            <div>
              <Envelope />
            </div>
          </div>
          <div className="pipe-ai">
            <AiMark />
            <span className="absolute left-full top-1/2 ml-2 -translate-y-1/2 whitespace-nowrap text-sm font-medium md:left-1/2 md:top-full md:ml-0 md:-translate-x-1/2 md:translate-y-1">
              Extracting
            </span>
          </div>
        </div>

        <div className="stage-out flex flex-col gap-3 py-2">
          <OutputCard enquiry={e} detail={detail} names={names} mood={view.mood} onOpen={onOpen} />
          <ProposalLink url={e.proposalUrl} />
        </div>
      </div>

      <div className="mt-6" aria-live="polite">
        <h2 className="display text-3xl font-semibold md:text-4xl">{view.headline}</h2>
        <p className="mt-1 max-w-2xl text-muted">{view.sub}</p>
      </div>
    </div>
  );
}

function OutputCard({ enquiry: e, detail, names, mood, onOpen }: Omit<Props, "now"> & { mood: string }) {
  const base = "min-h-40 rounded-3xl p-5";

  if (mood === "done") {
    const b = detail ? booking(detail.extracted, names) : null;
    const rows = b ? b.lines.map(lineText) : [];
    const facts = b ? b.facts.map((f) => f.value).join(" · ") : ""; // "Northwind AB · Offsite · 12–13 Mar 2027 · 12"
    return (
      <div className={`${base} bg-peach text-[color:var(--peach-ink)]`}>
        <h3 className="font-semibold">Booking details</h3>
        {rows.length || facts ? (
          <>
            <ul className="mt-3 space-y-1 text-lg font-medium leading-snug">
              {rows.map((text, i) => (
                <li key={text} className="line-in" style={{ animationDelay: `${i * 90}ms` }}>
                  {text}
                </li>
              ))}
            </ul>
            {facts && <p className="line-in mt-3 text-sm opacity-75" style={{ animationDelay: `${rows.length * 90}ms` }}>{facts}</p>}
          </>
        ) : (
          <p className="mt-3 text-sm opacity-80">{detail ? "The draft is ready. Open the proposal to see the lines." : "Loading the details…"}</p>
        )}
      </div>
    );
  }

  if (mood === "failed") {
    return (
      <div className={`${base} border-2 border-[color:var(--bad)] bg-surface`}>
        <h3 className="font-semibold text-[color:var(--tone-fail)]">Could not create the draft</h3>
        <p className="mt-2 text-sm">{explainError(e.lastError)}</p>
        <RetryButton id={e.id} className="mt-3" />
      </div>
    );
  }

  if (mood === "stopped") {
    return (
      <div className={`${base} border-2 border-[color:var(--warn)] bg-surface`}>
        <h3 className="font-semibold">Needs a human</h3>
        <p className="mt-2 text-sm text-muted">Open the details to see what was missing.</p>
        <button type="button" onClick={onOpen} className="mt-3 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition active:scale-[0.97]">
          See why
        </button>
      </div>
    );
  }

  if (mood === "drained") {
    return (
      <div className={`${base} border-2 border-dashed border-line`}>
        <h3 className="font-semibold">Nothing to book</h3>
        <p className="mt-2 text-sm text-muted">No draft is made for emails that are not enquiries.</p>
      </div>
    );
  }

  // waiting, moving, stalled: the card is empty until something lands in it
  return (
    <div className={`${base} border-2 border-dashed border-line`} aria-busy="true">
      <h3 className="font-semibold text-muted">Booking details</h3>
      <div className="mt-4 space-y-2" aria-hidden="true">
        {[70, 52, 62].map((w) => (
          <div key={w} className="h-3.5 animate-pulse rounded-full bg-line" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

// Always on screen, as in the sketch. Only a real link once the draft exists.
function ProposalLink({ url }: { url: string | null }) {
  const cls = "flex items-center justify-between rounded-full px-5 py-3 font-medium";
  if (!url) {
    return (
      <span className={`${cls} border border-line text-muted`} aria-disabled="true">
        Link to proposal
      </span>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={`${cls} bg-peach text-[color:var(--peach-ink)] transition hover:brightness-95 active:scale-[0.98]`}>
      Open proposal
      <ArrowUpRight className="h-4 w-4" />
    </a>
  );
}
