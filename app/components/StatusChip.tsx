import { STATUS_LABEL, type Status } from "@/lib/dashboard/view";

const TONE: Record<Status, string> = {
  queued: "var(--muted)",
  processing: "var(--accent)",
  retrying: "var(--warn)",
  draft_created: "var(--accent)",
  needs_review: "var(--warn)",
  failed_permanent: "var(--bad)",
  ignored: "var(--muted)",
};

// Colour is never the only signal: the label names the status. Only a working enquiry gets a pulsing dot.
export function StatusChip({ status }: { status: string }) {
  const label = STATUS_LABEL[status as Status] ?? status;
  const color = TONE[status as Status] ?? "var(--muted)";
  return (
    <span className="label inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium" style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
      {status === "processing" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {label}
    </span>
  );
}
