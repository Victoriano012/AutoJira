"use client";

import { useSyncExternalStore } from "react";
import { agentRequests, cancelRequest, retryRequest, subscribeRuns } from "@/lib/runner";
import type { AgentRequest } from "@/lib/types";

const NONE: AgentRequest[] = [];

/** The messages sent to the project agent that have not become tickets yet,
 * oldest first: the one being worked on spins, the ones behind it wait dimmer,
 * a failed one says why in red. Every row has a ✕ — stop, cancel or dismiss —
 * and a failed row a retry. A request that finished is simply gone from here:
 * its tickets are on the board. Nothing renders while the stack is empty. */
export default function RequestStack({ onDropped }: { onDropped?: (text: string) => void }) {
  const requests = useSyncExternalStore(subscribeRuns, agentRequests, () => NONE);
  if (requests.length === 0) return null;

  const drop = (r: AgentRequest) => {
    cancelRequest(r.id);
    // The running one is stopped and gone; the words of one that never ran, or
    // never got through, are still the person's to send again.
    if (r.state !== "running") onDropped?.(r.text);
  };

  return (
    <div className="space-y-1.5 pb-2">
      {requests.map((r) =>
        r.state === "error" ? (
          <div
            key={r.id}
            className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700"
          >
            <span className="min-w-0 flex-1 truncate" title={`${r.text}\n\n${r.error}`}>
              {r.text} — {r.error}
            </span>
            <button
              className="shrink-0 rounded-md bg-red-100 px-2 py-0.5 text-red-700 hover:bg-red-200"
              onClick={() => retryRequest(r.id)}
            >
              ↻ Retry
            </button>
            <button
              title="Dismiss and put the text back in the box"
              className="shrink-0 text-red-400 hover:text-red-600"
              onClick={() => drop(r)}
            >
              ✕
            </button>
          </div>
        ) : (
          <div
            key={r.id}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${
              r.state === "running"
                ? "border-violet-200 bg-violet-50 text-violet-800"
                : "border-zinc-200 bg-zinc-50 text-zinc-500"
            }`}
          >
            {r.state === "running" ? (
              <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-violet-300 border-t-violet-700" />
            ) : (
              <span className="h-3 w-3 shrink-0 rounded-full border-2 border-zinc-300" />
            )}
            <span className="min-w-0 flex-1 truncate" title={r.text}>
              {r.text}
            </span>
            <span className={`shrink-0 ${r.state === "running" ? "text-violet-500/70" : ""}`}>
              {r.state === "running"
                ? r.mode === "panel"
                  ? "breaking into tickets…"
                  : "working…"
                : "waiting"}
            </span>
            <button
              title={r.state === "running" ? "Stop this request" : "Cancel and put the text back in the box"}
              className={`shrink-0 ${
                r.state === "running"
                  ? "text-violet-400 hover:text-red-600"
                  : "text-zinc-400 hover:text-red-600"
              }`}
              onClick={() => drop(r)}
            >
              ✕
            </button>
          </div>
        )
      )}
    </div>
  );
}
