"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { EnquiryDetail, EnquirySummary } from "@/lib/db/enquiry-views";
import { STAGES, ago, pipeView, stageIndex, timeTaken, type Mood } from "@/lib/dashboard/view";
import { Alert, Check, Doc, Mail, Sparkle } from "./icons";

const GLYPH = [Mail, Sparkle, Doc, Check];

type Props = { enquiry: EnquirySummary; detail: EnquiryDetail | null; now: number };

// The first event of each kind marks when a stage was reached. Optional: the rail works from the status alone, and the
// timings appear once the detail has loaded.
const STAGE_STEPS = [["received"], ["claimed"], ["extracted"], ["draft_created", "draft_found"]];

function stageTimes(detail: EnquiryDetail | null): (string | null)[] {
  const t0 = detail?.events[0] ? Date.parse(detail.events[0].at) : null;
  return STAGE_STEPS.map((steps) => {
    const ev = detail?.events.find((e) => steps.includes(e.step));
    return ev && t0 !== null ? `+${((Date.parse(ev.at) - t0) / 1000).toFixed(1)} s` : null;
  });
}

type NodeState = "done" | "active" | "problem" | "muted" | "pending";

function nodeState(i: number, stage: number, mood: Mood): NodeState {
  if (mood === "done" || i < stage) return "done";
  if (i > stage) return "pending";
  if (mood === "stalled" || mood === "stopped" || mood === "failed") return "problem";
  return mood === "drained" ? "muted" : "active";
}

// The hero: one enquiry, shown as the state it is in and a rail of four stages the mail travels along.
// Parent keys this by enquiry id, so a new enquiry starts at the first stage and the bar travels in.
export function Pipeline({ enquiry: e, detail, now }: Props) {
  const view = pipeView(e, now);
  const stage = stageIndex(view.at);
  const [p, setP] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setP(stage / 3)); // one frame later, so the move is a transition and not a jump
    return () => cancelAnimationFrame(frame);
  }, [stage]);

  const times = stageTimes(detail);
  return (
    <section aria-label="Latest enquiry">
      <p className="flex flex-wrap items-baseline gap-x-3 text-sm text-muted">
        <span className="font-medium text-foreground">{e.subject || "(no subject)"}</span>
        <span className="[overflow-wrap:anywhere]">{e.sender || "unknown sender"}</span>
        <span className="num text-xs">{now ? ago(e.createdAt, now) : ""}</span>
      </p>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0" aria-live="polite">
          <h2 className="display text-5xl font-semibold md:text-7xl">{view.headline}</h2>
          <p className="mt-3 max-w-2xl text-pretty text-lg text-muted">{view.sub}</p>
        </div>
        <div className="shrink-0 md:text-right">
          <p className="num text-4xl font-medium tracking-tight">{now ? timeTaken(e, now) : "0 s"}</p>
          <p className="label mt-1 text-sm text-muted">{view.mood === "done" ? "From email to draft" : "Elapsed"}</p>
        </div>
      </div>

      <Rail mood={view.mood} p={p} stage={stage} times={times} />
    </section>
  );
}

function Rail({ mood, p, stage, times }: { mood: Mood; p: number; stage: number; times: (string | null)[] }) {
  return (
    <div className="rail-card mt-8 px-5 py-7 md:px-10 md:pb-7 md:pt-9">
      <ol className="rail" data-mood={mood} style={{ "--p": p } as CSSProperties}>
        <li className="rail-track" aria-hidden="true">
          <span className="rail-fill" />
        </li>
        {STAGES.map((s, i) => {
          const state: NodeState = stage < 0 ? "pending" : nodeState(i, stage, mood);
          const Glyph = GLYPH[i];
          return (
            <li key={s.label} className="stage" aria-current={i === stage ? "step" : undefined}>
              <span className="node" data-state={state}>
                {state === "problem" ? <Alert /> : <Glyph />}
              </span>
              <span className="stage-text">
                <span className={`block text-[15px] font-medium ${state === "pending" ? "text-muted" : ""}`}>{s.label}</span>
                <span className="block text-sm text-muted">{s.sub}</span>
                <span className="num block min-h-4 text-xs text-muted">{times[i] ?? ""}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// The hero with nothing to show: the same headline and rail, every stage still waiting.
export function IdlePipeline({ loading }: { loading: boolean }) {
  return (
    <section aria-label="Latest enquiry" aria-busy={loading}>
      <div aria-live="polite">
        <h2 className="display text-3xl font-semibold md:text-5xl">Waiting for the next enquiry</h2>
        <p className="mt-3 max-w-2xl text-pretty text-lg text-muted">Each enquiry travels these four stages, from inbox to draft.</p>
      </div>
      <Rail mood="waiting" p={0} stage={-1} times={[]} />
    </section>
  );
}
