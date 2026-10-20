"use client";

import type { EnquirySummary } from "@/lib/db/enquiry-views";
import { ago, timeTaken } from "@/lib/dashboard/view";
import { ArrowUpRight } from "./icons";
import { StatusChip } from "./StatusChip";

// Every enquiry, newest first. Clicking a row opens its drawer. The draft link is its own link, so it is one click from the list.
export function EnquiryList({ rows, now, focusId, onSelect, onHover, inbound }: { rows: EnquirySummary[]; now: number; focusId: string | null; onSelect: (id: string) => void; onHover?: (id: string) => void; inbound: string }) {
  if (!rows.length) {
    return (
      <div className="panel px-6 py-10 text-center">
        <p className="font-medium">No enquiries yet</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
          Email <span className="num [overflow-wrap:anywhere]">{inbound}</span> and the first one appears here.
        </p>
      </div>
    );
  }
  return (
    <ul className="panel divide-y divide-line overflow-hidden">
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
