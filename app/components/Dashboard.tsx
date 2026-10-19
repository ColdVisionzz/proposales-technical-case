"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EnquiryDetail, EnquirySummary } from "@/lib/db/enquiry-views";
import { useNow, usePoll } from "@/lib/dashboard/hooks";
import type { Health } from "@/lib/pipeline/health";
import { EnquiryDrawer } from "./EnquiryDrawer";
import { EnquiryList } from "./EnquiryList";
import { HealthBanner } from "./HealthBanner";
import { Check, Copy, Mark } from "./icons";
import { Pipeline } from "./Pipeline";
import { ProposalPreview } from "./ProposalPreview";

const INBOUND = process.env.NEXT_PUBLIC_INBOUND_ADDRESS || "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Owns the polling and the one piece of shared state: which enquiry is open, kept in the URL (?id=) so it can be linked
// and the Back button closes the drawer. The hero shows that enquiry, or the newest one.
export function Dashboard() {
  const router = useRouter();
  const param = useSearchParams().get("id");
  const selectedId = param && UUID.test(param) ? param : null;

  const now = useNow();
  const list = usePoll<{ enquiries: EnquirySummary[]; chaos: boolean }>("/api/enquiries", 2000);
  const health = usePoll<Health>("/api/health", 10_000);
  const catalog = usePoll<{ products: { variationId: number; title: string }[] }>("/api/catalog", null);
  const names = useMemo(() => (catalog.data ? new Map(catalog.data.products.map((p) => [p.variationId, p.title])) : null), [catalog.data]);

  const rows = list.data?.enquiries ?? [];
  const focus = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;
  const detailId = selectedId ?? focus?.id ?? null;
  const detail = usePoll<EnquiryDetail>(detailId ? `/api/enquiries/${detailId}` : null, 2000).data;
  const focusDetail = focus && detail?.id === focus.id ? detail : null;

  const open = (id: string) => router.push(`/?id=${id}`, { scroll: false });
  const close = () => {
    if (selectedId) router.replace("/", { scroll: false });
  };

  return (
    <>
      <div className="sticky top-0 z-30">
        <HealthBanner health={health.data} chaos={list.data?.chaos ?? false} offline={list.stale} />
        <header className="topbar">
          <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 md:px-8">
            <h1 className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
              <Mark className="h-6 w-6" />
              Inbox to Draft
            </h1>
            <div className="flex min-w-0 items-center gap-4">
              {INBOUND && <CopyAddress address={INBOUND} className="hidden sm:inline-flex" />}
              <p className="label flex items-center gap-2 text-sm text-muted" role="status">
                <span className={`h-1.5 w-1.5 rounded-full ${list.stale ? "bg-warn" : "animate-pulse bg-accent"}`} />
                {list.stale ? "Reconnecting" : "Live"}
              </p>
            </div>
          </div>
        </header>
      </div>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-20 pt-10 md:px-8 md:pt-14">
        {focus ? <Pipeline key={focus.id} enquiry={focus} detail={focusDetail} now={now} /> : <EmptyStage loading={!list.data} />}

        {focus && (
          <div className="mt-8 grid gap-8 lg:grid-cols-[5fr_7fr] lg:gap-6">
            <ProposalPreview key={focus.id} enquiry={focus} detail={focusDetail} names={names} now={now} onOpen={() => open(focus.id)} />
            <section aria-labelledby="recent">
              <h2 id="recent" className="mb-3 text-sm font-semibold lg:sr-only">
                Recent enquiries
              </h2>
              <EnquiryList rows={rows} now={now} focusId={focus.id} onSelect={open} inbound={INBOUND || "the inbound address"} />
            </section>
          </div>
        )}

        <p className="mt-14 max-w-xl text-sm text-muted">One shared inbox and no accounts. A real deployment would add sign-in and a separate inbox for each hotel.</p>
      </main>
      <EnquiryDrawer open={selectedId !== null} detail={detail?.id === selectedId ? detail : null} names={names} now={now} onClose={close} />
    </>
  );
}

function EmptyStage({ loading }: { loading: boolean }) {
  return (
    <section className="panel px-6 py-16 text-center" aria-busy={loading} aria-label="Latest enquiry">
      <Mark className="mx-auto h-8 w-8" />
      <h2 className="display mt-5 text-3xl font-semibold">{loading ? "Connecting" : "Waiting for the first enquiry"}</h2>
      {!loading && (
        <>
          <p className="mx-auto mt-2 max-w-md text-muted">Send an enquiry email to this address. It appears here the moment it arrives.</p>
          {INBOUND && <CopyAddress address={INBOUND} className="mt-6 inline-flex" />}
        </>
      )}
    </section>
  );
}

// The inbound address as one tap: copies it and says so. The label is announced politely, the timer clears on unmount.
function CopyAddress({ address, className = "" }: { address: string; className?: string }) {
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
