"use client";

import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "@/lib/layout";
import { runTicket, stopTicket } from "@/lib/runner";
import { useStore } from "@/lib/store";
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

/** Some agent is actually executing at or beneath this ticket. */
function agentWorking(t: Ticket): boolean {
  if (t.subgraph.tickets.length === 0) return t.status === "running";
  return t.subgraph.tickets.some(agentWorking);
}

const reviewBeneath = (g: TicketGraph): boolean =>
  g.tickets.some((t) => t.status === "review" || reviewBeneath(t.subgraph));

/** Nominally running but really just waiting on a person: no agent is active
 * beneath, and the stall is human-shaped — a review pending somewhere inside,
 * or this is a human_review ticket whose board awaits the person. */
function waitingOnHuman(t: Ticket): boolean {
  if (t.status !== "running" || agentWorking(t)) return false;
  return t.type === "human_review" || reviewBeneath(t.subgraph);
}

/** Green when done, amber when an unfinished human-review ticket, gray otherwise. */
function previewFill(t: Ticket): string {
  if (isTicketDone(t)) return "#aad4b1";
  if (t.type === "human_review") return "#dacb84";
  return "#d4d4d8";
}

/** Tiny static thumbnail of the ticket's subgraph, one layer deep: just dots. */
function SubgraphPreview({ graph }: { graph: TicketGraph }) {
  const W = 64;
  const H = 40;
  const PADX = 6;
  const PADY = 3;
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
    const sx = (x: number) => PADX + (spanX ? (x - minX) / spanX : 0.5) * (W - 2 * PADX);
    const sy = (y: number) => PADY + (spanY ? (y - minY) / spanY : 0.5) * (H - 2 * PADY);
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
  const waiting = waitingOnHuman(ticket);

  // Running a human-review ticket opens its kanban board (the board is the
  // human's interface to that work); the subgraph agents start underneath.
  function run() {
    if (ticket.type === "human_review") {
      useStore.getState().setPath([...path, ticket.id]);
      if (ticket.subgraph.tickets.length === 0) return; // empty board: just open it
    }
    void runTicket(path, ticket.id);
  }

  // Visible only while the node is hovered or selected; pointer events stay
  // on so dragging a link from where they sit works even mid-fade.
  const handleClass = `!h-2.5 !w-2.5 !border-zinc-400 !bg-zinc-300 transition-opacity duration-150 ${
    selected ? "!opacity-100" : "!opacity-0 group-hover:!opacity-100"
  }`;

  return (
    <div
      className={`group relative w-64 rounded-xl border-2 bg-white p-3 pb-2 shadow-lg shadow-zinc-900/10 ${
        selected
          ? "border-sky-400"
          : waiting
            ? borderByStatus.review
            : borderByStatus[ticket.status]
      }`}
    >
      <Handle type="target" position={Position.Left} className={handleClass} />
      <Handle type="source" position={Position.Right} className={handleClass} />

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
              if (ready) run();
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
        ) : ticket.status === "running" ? (
          <span className="flex items-center gap-1.5">
            {!waiting && (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border border-blue-400 border-t-transparent" />
            )}
            {/* A sized square, not the ◼ glyph: font rendering made it tiny. */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                stopTicket(path, ticket.id);
              }}
              title="Stop"
              className="h-3 w-3 rounded-[3px] bg-red-600 hover:bg-red-500"
            />
          </span>
        ) : (
          <span className={`flex items-center gap-1 text-[10px] ${statusText[ticket.status]}`}>
            {statusLabel[ticket.status]}
          </span>
        )}
      </div>

      {(ticket.status === "review" || ticket.status === "error") && (
        <div className="mt-2 flex items-center gap-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              run();
            }}
            className="rounded-md bg-zinc-100 px-2 py-1 text-[11px] text-zinc-700 hover:bg-zinc-200"
          >
            ▶ Run
          </button>
        </div>
      )}
    </div>
  );
}

export const TicketNode = memo(TicketNodeInner);
