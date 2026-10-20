"use client";

import { useMemo } from "react";
import { mailtoHref, qrPath } from "@/lib/dashboard/qr";
import { CopyAddress } from "./CopyAddress";
import { Mail } from "./icons";

// Shown in the preview slot while no row is hovered or open. One job: get a visitor to send an email. A phone cannot scan
// its own screen, so below lg the QR code gives way to a button that opens the mail app.
export function DemoIntro({ address }: { address: string }) {
  const href = mailtoHref(address);
  const qr = useMemo(() => qrPath(href), [href]);

  return (
    <section className="panel fade-in flex min-h-72 flex-col overflow-y-auto lg:h-[32rem]" aria-labelledby="intro-title">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-background/60 px-5 py-3.5">
        <h3 id="intro-title" className="text-sm font-semibold">
          Try it yourself
        </h3>
        <span className="label text-xs text-muted">Demo system</span>
      </header>

      <div className="flex flex-col gap-6 px-5 py-5">
        <div>
          <p className="display text-3xl font-semibold">Email an enquiry. Watch it become a draft.</p>
          <p className="mt-3 max-w-sm text-sm text-muted">One shared inbox. Write as a fictional organisation and leave out personal details. Your email appears in the list within seconds.</p>
        </div>

        <div className="flex flex-col items-center gap-4">
          <CopyAddress address={address} className="inline-flex max-w-full" />
          <a href={href} className="press inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 lg:hidden">
            <Mail className="h-4 w-4" />
            Email the demo
          </a>
          <a href={href} className="hidden shrink-0 rounded-xl border border-line bg-white p-2 lg:block" aria-label={`Open an email to ${address}`}>
            <svg viewBox={`-4 -4 ${qr.size + 8} ${qr.size + 8}`} className="h-36 w-36" role="img" aria-label={`QR code for ${address}`} shapeRendering="crispEdges">
              <path d={qr.d} fill="#0d1512" />
            </svg>
          </a>
        </div>
      </div>
    </section>
  );
}
