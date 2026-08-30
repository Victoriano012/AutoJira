"use client";

import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "@/lib/layout";
import { runTicket, stopTicket } from "@/lib/runner";
import { isTicketDone, Ticket, TicketGraph, TicketStatus } from "@/lib/types";
import { Handle, NodeProps, Position, type Node } from "@xyflow/react";
import { memo, useMemo } from "react";

export type TicketNodeType = Node<
  { ticket: Ticket; path: string[]; ready: boolean },
  "ticket"
>;

const borderByStatus: Record<TicketStatus, string> = {
  todo: "border-zinc-300",
  running: "border-blue-400 animate-pulse",
  review: "border-amber-400",
  done: "border-emerald-500",
  error: "border-red-500",
};

const statusLabel: Record<TicketStatus, string> = {
  todo: "To do",
  running: "Running",
  review: "Needs review",
  done: "Done",
  error: "Failed",
};

const statusText: Record<TicketStatus, string> = {
  todo: "text-zinc-500",
  running: "text-blue-500",
  review: "text-amber-500",
  done: "text-emerald-600",
  error: "text-red-500",
};

/** Green when done, amber when an unfinished human-review ticket, gray otherwise. */
function previewFill(t: Ticket): string {
  if (isTicketDone(t)) return "#10b981";
  if (t.type === "human_review") return "#fbbf24";
  return "#d4d4d8";
}

/** Tiny static thumbnail of the ticket's subgraph, one layer deep: just dots. */
function SubgraphPreview({ graph }: { graph: TicketGraph }) {
  const W = 64;
  const H = 40;
  const PAD = 6;
  const { centers, sx, sy } = useMemo(() => {
    const fallback = graph.tickets.some((t) => !t.position) ? layoutGraph(graph) : null;
    const centers = new Map<string, { x: number; y: number }>();
    for (const t of graph.tickets) {
      const p = t.position ?? fallback!.get(t.id)!;
      centers.set(t.id, { x: p.x + NODE_WIDTH / 2, y: p.y + NODE_HEIGHT / 2 });
    }
    const xs = [...centers.values()].map((c) => c.x);
    const ys = [...centers.values()].map((c) => c.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const spanX = Math.max(...xs) - minX;
    const spanY = Math.max(...ys) - minY;
    const sx = (x: number) => PAD + (spanX ? (x - minX) / spanX : 0.5) * (W - 2 * PAD);
    const sy = (y: number) => PAD + (spanY ? (y - minY) / spanY : 0.5) * (H - 2 * PAD);
    return { centers, sx, sy };
  }, [graph]);

  return (
    <svg width={W} height={H} className="shrink-0">
      {graph.tickets.map((t) => {
        const c = centers.get(t.id)!;
        return (
          <rect
            key={t.id}
            x={sx(c.x) - 4}
            y={sy(c.y) - 2.5}
            width={8}
            height={5}
            rx={1.5}
            fill={previewFill(t)}
          />
        );
      })}
    </svg>
  );
}

function TicketNodeInner({ data, selected }: NodeProps<TicketNodeType>) {
  const { ticket, path, ready } = data;

  return (
    <div
      className={`relative w-64 rounded-xl border-2 bg-white p-3 shadow-lg shadow-zinc-900/10 ${
        borderByStatus[ticket.status]
      } ${selected ? "ring-2 ring-sky-400" : ""}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-zinc-400 !bg-zinc-300"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-zinc-400 !bg-zinc-300"
      />

      {ticket.status === "done" && (
        <span className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-sm font-bold text-white">
          ✓
        </span>
      )}

      <div className="line-clamp-2 text-sm font-medium text-zinc-900">
        {ticket.title}
      </div>

      <div className="mt-1.5 flex items-end justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {ticket.type === "ai" ? (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">
              AI
            </span>
          ) : (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium text-amber-700 ${
                ticket.blocking === false
                  ? "border border-amber-400"
                  : "bg-amber-100"
              }`}
              title={
                ticket.blocking === false
                  ? "Non-blocking review: dependents start before approval (on a git branch)"
                  : "Blocks dependents until approved"
              }
            >
              Human{ticket.blocking === false ? " ⇢" : ""}
            </span>
          )}
        </div>
        {ticket.subgraph.tickets.length > 0 && (
          <SubgraphPreview graph={ticket.subgraph} />
        )}
        {ticket.status === "todo" ? (
          <button
            disabled={!ready}
            onClick={(e) => {
              e.stopPropagation();
              if (ready) void runTicket(path, ticket.id);
            }}
            title={ready ? "Run" : "Waiting on dependencies"}
            className={`text-sm leading-none ${
              ready
                ? "text-emerald-600 hover:text-emerald-500"
                : "cursor-not-allowed text-zinc-400"
            }`}
          >
            ▶
          </button>
        ) : (
          <span className={`flex items-center gap-1 text-[10px] ${statusText[ticket.status]}`}>
            {ticket.status === "running" && (
              <span className="h-2.5 w-2.5 animate-spin rounded-full border border-blue-400 border-t-transparent" />
            )}
            {statusLabel[ticket.status]}
          </span>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {ticket.status === "running" ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                stopTicket(path, ticket.id);
              }}
              className="rounded-md bg-zinc-100 px-2 py-1 text-[11px] text-red-600 hover:bg-zinc-200"
            >
              ◼ Stop
            </button>
          ) : ticket.status === "review" || ticket.status === "error" ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void runTicket(path, ticket.id);
              }}
              className="rounded-md bg-zinc-100 px-2 py-1 text-[11px] text-zinc-700 hover:bg-zinc-200"
            >
              ▶ Run
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const TicketNode = memo(TicketNodeInner);
