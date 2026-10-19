"use client";

import { useState } from "react";

// Manual retry of a failed enquiry. The server only accepts it from failed_permanent, so a second press or a stale screen is
// answered with a plain message instead of changing anything. The list poll then shows the row moving again.
export function RetryButton({ id, className = "" }: { id: string; className?: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [note, setNote] = useState<string | null>(null);

  async function retry() {
    setState("sending");
    setNote(null);
    try {
      const res = await fetch(`/api/enquiries/${id}/retry`, { method: "POST" });
      if (res.ok) return setState("sent");
      setState("error");
      setNote(res.status === 409 ? "Already retried: it is back in the queue." : "Could not retry. Try again in a moment.");
    } catch {
      setState("error");
      setNote("Could not reach the server. Try again in a moment.");
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={retry}
        disabled={state === "sending" || state === "sent"}
        className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition active:scale-[0.97] disabled:opacity-50"
      >
        {state === "sending" ? "Retrying…" : state === "sent" ? "Back in the queue" : "Retry now"}
      </button>
      {note && (
        <p role="status" className="mt-2 text-sm text-muted">
          {note}
        </p>
      )}
    </div>
  );
}
