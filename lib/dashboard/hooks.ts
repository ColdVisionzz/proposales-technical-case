"use client";

import { useEffect, useState } from "react";

type Loaded<T> = { url: string; data: T };

// Fetch a JSON route now and then every `everyMs` (null = once). Rules that keep a 2 s poll cheap and honest:
//  - the next request is scheduled only after the last one ends, so slow answers never pile up;
//  - nothing is fetched while the tab is hidden, and one fetch fires the moment it is shown again;
//  - the last good answer stays on screen when a request fails, and `stale` says so;
//  - data is tied to its url, so switching to another enquiry never shows the previous one's data.
export function usePoll<T>(url: string | null, everyMs: number | null): { data: T | null; stale: boolean } {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const run = async () => {
      if (!alive) return;
      if (document.hidden) return; // resumed by the visibilitychange listener below
      controller = new AbortController();
      try {
        const res = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as T;
        if (alive) {
          setLoaded({ url, data });
          setFailedUrl(null);
        }
      } catch {
        if (alive && !controller.signal.aborted) setFailedUrl(url);
      }
      if (alive && everyMs !== null) timer = setTimeout(run, everyMs);
    };

    const onVisible = () => {
      if (!document.hidden && alive && everyMs !== null) {
        clearTimeout(timer);
        void run();
      }
    };
    void run();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, everyMs]);

  return { data: loaded && loaded.url === url ? loaded.data : null, stale: failedUrl === url };
}

// A clock that ticks every second, for countdowns and "time taken" on rows that are still moving.
// Starts at 0 and gets its first real value right after mount: reading the clock while rendering would make the server's
// prerender and the browser disagree (and Cache Components refuses a clock read there). Data only arrives after mount, so
// nothing time-based is shown before the first tick.
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, everyMs);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [everyMs]);
  return now;
}
