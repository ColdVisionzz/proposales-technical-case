"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import type { EnquiryDetail, EnquirySummary } from "@/lib/db/enquiry-views";
import { useNow, usePoll } from "@/lib/dashboard/hooks";
import type { Health } from "@/lib/pipeline/health";
import { EnquiryDrawer } from "./EnquiryDrawer";
import { EnquiryList } from "./EnquiryList";
import { HealthBanner } from "./HealthBanner";
import { Pipeline } from "./Pipeline";

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

  const open = (id: string) => router.push(`/?id=${id}`, { scroll: false });
  const close = () => {
    if (selectedId) router.replace("/", { scroll: false });
  };

  return (
    <>
      <HealthBanner health={health.data} chaos={list.data?.chaos ?? false} offline={list.stale} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-8 md:px-8 md:pt-12">
        <header className="mb-10 flex flex-wrap items-end justify-between gap-4 md:mb-14">
          <div>
            <h1 className="display text-4xl font-semibold md:text-6xl">Inbox to Draft</h1>
            <p className="mt-2 text-lg text-muted">
              Email a booking to <span className="font-medium text-[color:var(--signal)] [overflow-wrap:anywhere]">{INBOUND || "the inbound address"}</span> and watch it become a draft proposal.
            </p>
          </div>
          <p className="flex items-center gap-2 text-sm text-muted" role="status">
            <span className={`h-2 w-2 rounded-full ${list.stale ? "bg-[color:var(--warn)]" : "animate-pulse bg-[color:var(--signal)]"}`} />
            {list.stale ? "Reconnecting" : "Live"}
          </p>
        </header>

        {focus ? (
          <Pipeline key={focus.id} enquiry={focus} detail={detail?.id === focus.id ? detail : null} names={names} now={now} onOpen={() => open(focus.id)} />
        ) : (
          <EmptyStage loading={!list.data} />
        )}

        <section className="mt-16" aria-labelledby="recent">
          <h2 id="recent" className="mb-3 text-xl font-semibold">
            Recent enquiries
          </h2>
          {list.data ? (
            <EnquiryList rows={rows} now={now} focusId={focus?.id ?? null} onSelect={open} inbound={INBOUND || "the inbound address"} />
          ) : (
            <div className="h-40 animate-pulse rounded-3xl bg-line" aria-busy="true" />
          )}
        </section>

        <p className="mt-16 text-sm text-muted">Demo build: one shared inbox, no accounts. A real product would use proper sign-in and a separate inbox for each hotel.</p>
      </main>
      <EnquiryDrawer open={selectedId !== null} detail={detail?.id === selectedId ? detail : null} names={names} now={now} onClose={close} />
    </>
  );
}

function EmptyStage({ loading }: { loading: boolean }) {
  return (
    <div className="rounded-3xl border-2 border-dashed border-line px-6 py-16 text-center" aria-busy={loading}>
      <p className="display text-2xl font-semibold">{loading ? "Connecting…" : "The pipe is empty"}</p>
      {!loading && <p className="mx-auto mt-2 max-w-md text-muted">Send an enquiry to the address above. It shows up here the moment it arrives.</p>}
    </div>
  );
}
