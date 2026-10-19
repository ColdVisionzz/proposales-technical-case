import { STATUS_LABEL, type Status } from "@/lib/dashboard/view";

const TONE: Record<Status, string> = {
  queued: "var(--tone-wait)",
  processing: "var(--tone-work)",
  retrying: "var(--tone-retry)",
  draft_created: "var(--tone-done)",
  needs_review: "var(--tone-review)",
  failed_permanent: "var(--tone-fail)",
  ignored: "var(--tone-wait)",
};

// Colour is never the only signal: the label says the status, and the dot shape differs for "working" (pulses).
export function StatusChip({ status }: { status: string }) {
  const label = STATUS_LABEL[status as Status] ?? status;
  const color = TONE[status as Status] ?? "var(--tone-wait)";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${status === "processing" ? "animate-pulse" : ""}`} />
      {label}
    </span>
  );
}
