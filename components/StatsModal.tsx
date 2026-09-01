"use client";

import { useEffect } from "react";
import {
  collectStats,
  formatCost,
  formatDuration,
  formatTokens,
} from "@/lib/stats";
import { useStore } from "@/lib/store";
import { contextChain, graphAtPath, type TicketStatus } from "@/lib/types";

const STATUSES: { key: TicketStatus; label: string; bar: string }[] = [
  { key: "done", label: "Done", bar: "bg-emerald-400" },
  { key: "review", label: "In review", bar: "bg-amber-400" },
  { key: "running", label: "Running", bar: "bg-blue-400" },
  { key: "todo", label: "To do", bar: "bg-zinc-400" },
  { key: "error", label: "Failed", bar: "bg-red-400" },
];

function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-sm text-zinc-600">{label}</span>
      <span className="text-right">
        <span className="text-sm font-medium tabular-nums text-zinc-900">{value}</span>
        {note && <span className="ml-2 text-[11px] text-zinc-400">{note}</span>}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        {title}
      </h3>
      <div className="mt-1 divide-y divide-zinc-100">{children}</div>
    </div>
  );
}

/**
 * What this level of the project cost: the graph the person is looking at and
 * everything nested beneath it — at the root, the whole project.
 *
 * Every number is measured, never modelled. Time is wall-clock around each
 * agent session; tokens and cost are what the provider reported (the Codex CLI
 * reports no cost, and those runs are called out rather than priced from a
 * table); rejections are counted as they happen. Runs from before any of this
 * was recorded show as "not recorded", not as zero.
 */
export default function StatsModal({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const path = useStore((s) => s.path);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const graph = graphAtPath(project.graph, path);
  const stats = collectStats(graph ?? { tickets: [], edges: [] });
  const chain = contextChain(project, path);
  const level = chain[chain.length - 1]?.title ?? project.name;

  // Nothing below this level has recorded totals: an older project, or work
  // that has not run yet. Saying "0" would claim a measurement nobody took.
  const measured = stats.measured > 0;
  const costed = stats.runs - stats.runsWithoutCost;
  const notRecorded = "not recorded";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Stats</h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          {path.length === 0 ? (
            <>Whole project — “{level}”</>
          ) : (
            <>“{level}” and everything inside it</>
          )}
        </p>

        <div className="mt-5 space-y-5">
          <Section title="Tickets">
            <Row label="Total" value={String(stats.tickets)} />
            <Row label="AI tickets" value={String(stats.ai)} />
            <Row label="Interaction tickets" value={String(stats.interaction)} />
          </Section>

          {stats.tickets > 0 && (
            <div>
              <div className="flex h-2 overflow-hidden rounded-full bg-zinc-100">
                {STATUSES.map(({ key, bar }) => (
                  <div
                    key={key}
                    className={bar}
                    style={{ width: `${(stats.byStatus[key] / stats.tickets) * 100}%` }}
                  />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {STATUSES.filter(({ key }) => stats.byStatus[key] > 0).map(
                  ({ key, label, bar }) => (
                    <span key={key} className="flex items-center gap-1.5 text-xs">
                      <span className={`h-2 w-2 rounded-full ${bar}`} />
                      <span className="text-zinc-500">{label}</span>
                      <span className="tabular-nums text-zinc-900">
                        {stats.byStatus[key]}
                      </span>
                    </span>
                  )
                )}
              </div>
            </div>
          )}

          <Section title="AI work">
            <Row
              label="Time in AI calls"
              value={measured ? formatDuration(stats.ms) : notRecorded}
            />
            <Row label="Agent runs" value={measured ? String(stats.runs) : notRecorded} />
            <Row
              label="Tokens"
              value={measured ? `${formatTokens(stats.tokens)} tokens` : notRecorded}
            />
            <Row
              label="Cost"
              value={
                !measured
                  ? notRecorded
                  : costed === 0
                    ? "not reported"
                    : formatCost(stats.costUsd)
              }
              note={
                measured && stats.runsWithoutCost > 0
                  ? `${costed}/${stats.runs} runs priced`
                  : undefined
              }
            />
          </Section>
          {measured && stats.runsWithoutCost > 0 && (
            <p className="-mt-3 text-[11px] leading-snug text-zinc-400">
              {stats.runsWithoutCost} run{stats.runsWithoutCost === 1 ? "" : "s"} came
              from the Codex CLI, which reports tokens but no cost — their spend is not
              in the total.
            </p>
          )}

          <Section title="Reviews">
            <Row
              label="Rejections"
              value={measured ? String(stats.rejections) : notRecorded}
            />
            <Row
              label="Interaction tickets reviewed"
              value={`${stats.reviewed} of ${stats.interaction}`}
            />
            <Row
              label="Rejections per reviewed ticket"
              value={
                stats.rejectionsPerInteraction === null
                  ? "—"
                  : stats.rejectionsPerInteraction.toFixed(2)
              }
            />
          </Section>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            autoFocus
            className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
