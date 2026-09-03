"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { agentBusy, subscribeRuns } from "@/lib/runner";
import { useStore } from "@/lib/store";

/**
 * The project agent's conversation, slid up over the board when the person
 * switches to act mode and back down when they leave it.
 *
 * Mounted only while it is on screen or on its way off: `open` flipping true
 * mounts it below the fold and, a frame later, sends it up; flipping false
 * sends it down and unmounts it once the transform has finished travelling
 * (see `.act-sheet` in globals.css). Clicks pass through it until it has fully
 * arrived, so a press meant for the board mid-flight does not land on the chat.
 * The transition's end is what moves it on, with a timer behind it for the
 * reduced-motion case where there is no transition to end.
 */
/** Where the sheet is on its way: mounted below the fold, travelling up, in
 * place, or travelling down (then unmounted). */
type Phase = "closed" | "entering" | "sliding" | "open" | "leaving";

export default function ActSheet({ open }: { open: boolean }) {
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");

  useEffect(() => {
    // A frame later, not now: the sheet has to paint once at its start position
    // for the change to be something the transition travels.
    let raf = requestAnimationFrame(() => {
      if (open) {
        setPhase((p) => (p === "open" ? p : "entering"));
        raf = requestAnimationFrame(() => setPhase((p) => (p === "entering" ? "sliding" : p)));
      } else {
        setPhase((p) => (p === "closed" ? p : "leaving"));
      }
    });
    // Reduced motion has no transition to end, so the arrival is timed too.
    const timer = setTimeout(
      () =>
        setPhase((p) =>
          open ? (p === "sliding" ? "open" : p) : p === "leaving" ? "closed" : p
        ),
      650
    );
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [open]);

  if (phase === "closed") return null;
  const shown = phase === "sliding" || phase === "open";
  return (
    <div
      data-open={shown}
      className={`act-sheet absolute inset-0 z-20 bg-white flex flex-col${
        phase === "open" ? "" : " pointer-events-none"
      }`}
      onTransitionEnd={(e) => {
        if (e.target !== e.currentTarget || e.propertyName !== "transform") return;
        setPhase(open ? "open" : "closed");
      }}
    >
      <Transcript />
    </div>
  );
}

function Transcript() {
  const chat = useStore((s) => s.project.chat);
  const busy = useSyncExternalStore(subscribeRuns, agentBusy, () => false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat.length, busy]);

  return (
    <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
      {chat.map((m, i) => {
        switch (m.kind) {
          case "user":
            return (
              <p
                key={i}
                className="bg-zinc-100 px-2 py-1 font-mono text-sm text-zinc-700 whitespace-pre-wrap"
              >
                <span className="text-zinc-400">&gt; </span>
                {m.text}
              </p>
            );
          case "tool":
            return (
              <p key={i} className="overflow-hidden text-ellipsis whitespace-pre font-mono text-xs text-zinc-400">
                {m.text}
              </p>
            );
          case "info":
            return (
              <p key={i} className="truncate font-mono text-xs italic text-zinc-400">
                {m.text}
              </p>
            );
          case "error":
            return (
              <p key={i} className="font-mono text-sm text-red-600 whitespace-pre-wrap">
                {m.text}
              </p>
            );
          default:
            return (
              <p key={i} className="font-mono text-sm text-zinc-800 whitespace-pre-wrap">
                {m.text}
              </p>
            );
        }
      })}
      {busy && (
        <p className="font-mono text-sm text-zinc-500 animate-pulse whitespace-pre-wrap">
          Working…
        </p>
      )}
    </div>
  );
}
