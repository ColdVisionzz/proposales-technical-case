"use client";

import type { EnquirySummary } from "@/lib/db/enquiry-views";
import { ago, timeTaken } from "@/lib/dashboard/view";
import { ArrowUpRight, Mail } from "./icons";
import { StatusChip } from "./StatusChip";

// The box keeps one size on wide screens, empty or full: a long list scrolls inside it instead of stretching the page.
// Below lg it only caps its height, so a short list does not leave a hollow box and a touch scroll cannot get trapped.
export const BOX = "max-h-[28rem] min-h-64 lg:h-[32rem] lg:max-h-none";

// Every enquiry, newest first. Clicking a row opens its drawer. The draft link is its own link, so it is one click from the list.
export function EnquiryList({ rows, now, focusId, onSelect, onHover }: { rows: EnquirySummary[]; now: number; focusId: string | null; onSelect: (id: string) => void; onHover?: (id: string) => void }) {
  return (
    <section className={`panel ${BOX} flex flex-col overflow-hidden`} aria-labelledby="recent">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-background/60 px-5 py-3.5">
        <h2 id="recent" className="text-sm font-semibold">
          Recent enquiries
        </h2>
        <span className="num text-xs text-muted">{rows.length}</span>
      </header>
      {rows.length ? <Rows rows={rows} now={now} focusId={focusId} onSelect={onSelect} onHover={onHover} /> : <Empty />}
    </section>
  );
}

function Empty() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-background text-muted" aria-hidden="true">
        <Mail className="h-5 w-5" />
      </span>
      <div>
        <p className="font-medium">No recent enquiries</p>
        <p className="mx-auto mt-1 max-w-xs text-sm text-muted">Enquiries from the last 15 minutes show up here as they arrive.</p>
      </div>
    </div>
  );
}

function Rows({ rows, now, focusId, onSelect, onHover }: { rows: EnquirySummary[]; now: number; focusId: string | null; onSelect: (id: string) => void; onHover?: (id: string) => void }) {
  return (
    <ul className="flex-1 divide-y divide-line overflow-y-auto">
      {rows.map((r) => (
        <li key={r.id} className="relative flex items-stretch">
          {r.id === focusId && <span className="absolute inset-y-0 left-0 w-[3px] bg-accent" aria-hidden="true" />}
          <button
            type="button"
            onClick={() => onSelect(r.id)}
            onMouseEnter={() => onHover?.(r.id)}
            onFocus={() => onHover?.(r.id)}
            aria-current={r.id === focusId ? "true" : undefined}
            className={`press grid min-w-0 flex-1 grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-3 text-left hover:bg-background ${r.id === focusId ? "bg-background" : ""}`}
          >
            <span className="grid h-9 w-9 place-items-center rounded-full bg-background text-sm font-semibold text-muted" aria-hidden="true">
              {(r.sender || r.subject || "?").replace(/^[^a-z0-9]+/i, "").charAt(0).toUpperCase() || "?"}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{r.subject || "(no subject)"}</span>
              <span className="block truncate text-sm text-muted">{r.sender || "unknown sender"}</span>
            </span>
            <span className="flex flex-col items-end gap-1">
              <span className="flex items-center gap-2">
                <span className="num text-xs text-muted" title="Time from arrival to now or to the final status">{now ? timeTaken(r, now) : ""}</span>
                <StatusChip status={r.status} />
              </span>
              <span className="num text-xs text-muted">{now ? ago(r.createdAt, now) : ""}</span>
            </span>
          </button>
          {r.proposalUrl && (
            <a href={r.proposalUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open the proposal for ${r.subject || "this enquiry"}`} className="press flex w-12 items-center justify-center text-muted hover:bg-background hover:text-foreground">
              <ArrowUpRight className="h-4 w-4" />
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
