"use client";

import type { EnquirySummary } from "@/lib/db/enquiry-views";
import { ago, timeTaken } from "@/lib/dashboard/view";
import { ArrowUpRight } from "./icons";
import { StatusChip } from "./StatusChip";

// Every enquiry, newest first. Clicking a row opens its drawer. The draft link is its own link, so it is one click from the list.
export function EnquiryList({ rows, now, focusId, onSelect, inbound }: { rows: EnquirySummary[]; now: number; focusId: string | null; onSelect: (id: string) => void; inbound: string }) {
  if (!rows.length) {
    return (
      <div className="rounded-3xl border-2 border-dashed border-line p-8 text-center">
        <p className="font-medium">No enquiries yet</p>
        <p className="mt-1 text-sm text-muted">
          Email {inbound} and watch it travel down the pipe.
        </p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-3xl border border-line bg-surface">
      {rows.map((r) => (
        <li key={r.id} className={`flex items-stretch ${r.id === focusId ? "bg-[color:var(--background)]" : ""}`}>
          <button type="button" onClick={() => onSelect(r.id)} className="grid min-w-0 flex-1 grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 px-4 py-3.5 text-left transition hover:bg-[color:var(--background)] active:scale-[0.995] md:grid-cols-[9.5rem_1fr_auto]">
            <span className="justify-self-start">
              <StatusChip status={r.status} />
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium">{r.subject || "(no subject)"}</span>
              <span className="block truncate text-sm text-muted">{r.sender || "unknown sender"}</span>
            </span>
            <span className="col-span-2 flex gap-3 text-sm tabular-nums text-muted md:col-span-1 md:flex-col md:items-end md:gap-0">
              <span>{now ? timeTaken(r, now) : ""}</span>
              <span>{now ? ago(r.createdAt, now) : ""}</span>
            </span>
          </button>
          {r.proposalUrl && (
            <a href={r.proposalUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open the proposal for ${r.subject || "this enquiry"}`} className="flex items-center gap-1 px-4 text-sm font-medium text-[color:var(--tone-done)] transition hover:bg-[color:var(--background)]">
              <span className="hidden md:inline">Proposal</span>
              <ArrowUpRight className="h-4 w-4" />
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
