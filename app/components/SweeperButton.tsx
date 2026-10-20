"use client";

import { useEffect, useRef, useState } from "react";
import { Refresh } from "./icons";

// Wakes enquiries that got stuck (the daily cron does the same once a day). An icon-only square for the top bar: the tooltip
// names it on hover or keyboard focus, and then reports what the sweep found for a few seconds.
export function SweeperButton() {
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function run() {
    setRunning(true);
    setNote(null);
    let result: string;
    try {
      const res = await fetch("/api/sweeper", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const { failed, nudged } = (await res.json()) as { failed: number; nudged: number };
      result = failed + nudged === 0 ? "Nothing was stuck" : `Restarted ${nudged}, gave up on ${failed}`;
    } catch {
      result = "Could not run it. Try again";
    }
    setRunning(false);
    setNote(result);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), 4000);
  }

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={run}
        disabled={running}
        aria-label="Retry stuck enquiries"
        className="press grid h-8 w-8 place-items-center rounded-lg border border-line-strong bg-surface text-muted hover:text-foreground disabled:opacity-60"
      >
        <Refresh className={`h-4 w-4 ${running ? "animate-spin" : ""}`} />
      </button>
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute right-0 top-full z-40 mt-2 whitespace-nowrap rounded-lg bg-foreground px-2.5 py-1.5 text-xs text-background transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 ${note ? "opacity-100" : "opacity-0"}`}
      >
        {note ?? "Retry stuck enquiries"}
      </span>
      <span role="status" className="sr-only">
        {note}
      </span>
    </div>
  );
}
