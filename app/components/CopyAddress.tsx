"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "./icons";

// The inbound address as one tap: copies it and says so. The label is announced politely, the timer clears on unmount.
export function CopyAddress({ address, className = "" }: { address: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked: the address stays selectable on screen, nothing else to do.
    }
  }

  return (
    <button type="button" onClick={copy} aria-label={`Copy the inbound address ${address}`} className={`press num min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm hover:border-line-strong ${className}`}>
      <span className="truncate">{address}</span>
      {copied ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" /> : <Copy className="h-3.5 w-3.5 shrink-0 text-muted" />}
      <span className="sr-only" role="status">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
