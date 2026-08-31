"use client";

import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "@/lib/layout";
import { runTicket, stopTicket } from "@/lib/runner";
import { useStore } from "@/lib/store";
import {
  graphAtPath,
  isTicketDone,
  isTicketRunning,
  isTicketWaiting,
  Ticket,
  TicketGraph,
  TicketStatus,
} from "@/lib/types";
import { Handle, NodeProps, Position, type Node } from "@xyflow/react";
import { ArrowRightIcon, Spinner, StopSquare } from "./icons";
import { ackKey, ackSubgraphRun, useTicketAck } from "./useRunAck";
import { memo, useEffect, useMemo, useRef, useState } from "react";

export type TicketNodeType = Node<
  { ticket: Ticket; path: string[]; ready: boolean },
  "ticket"
>;

const borderByStatus: Record<TicketStatus, string> = {
  todo: "border-zinc-300",
  running: "border-blue-400",
  review: "border-amber-400",
  done: "border-emerald-500",
  error: "border-red-500",
};

/**
 * Ids the canvas has already drawn. The first node of a graph level seeds the
 * whole level, so opening a project or drilling into a subgraph animates
 * nothing — only a ticket that turns up afterwards is new, and it grows in.
 */
const drawn = new Set<string>();
function isNewOnCanvas(id: string, path: string[]): boolean {
  if (drawn.has(id)) return false;
  const project = useStore.getState().project;
  const siblings = project ? (graphAtPath(project.graph, path)?.tickets ?? []) : [];
  const seeded = siblings.some((s) => drawn.has(s.id));
  for (const s of siblings) drawn.add(s.id);
  drawn.add(id);
  return seeded;
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
  // The two states are derived, not read off the raw status: a ticket with a
  // subgraph stays "running" while its scheduler drives it, even once every
  // agent inside has stopped and only the human can move things on.
  // …plus the beat a graph run marks this ticket with when the run has nothing
  // to do here but park on it again (a direct click on the play button below
  // never does this — it either really runs, or the state speaks for itself).
  const swept = useTicketAck(ackKey(path, ticket.id));
  const running = isTicketRunning(ticket) || swept;
  const waiting = isTicketWaiting(ticket, ready) && ticket.status !== "error";
  // "review" is latched: the runner wrote it when it handed this gate to the
  // person. Reopening something upstream blocks the ticket again without
  // rewriting that status, so the border reads it as todo — amber means
  // "waiting on you right now", never "was, once".
  const shown: TicketStatus = ticket.status === "review" && !ready ? "todo" : ticket.status;

  // Grows in once, on the render that first puts this ticket on the canvas.
  const [appeared] = useState(() => isNewOnCanvas(ticket.id, path));

  // One-shot nudge, either on the transition into Waiting or at the end of
  // that swept beat — a ticket parked on a human is usually already Waiting
  // when the run reaches it, and the nudge is the whole point of the feedback.
  // It never repeats while the ticket sits there.
  const was = useRef({ waiting, swept });
  const [nudge, setNudge] = useState(false);
  useEffect(() => {
    const entered =
      waiting && (!was.current.waiting || (was.current.swept && !swept));
    was.current = { waiting, swept };
    if (!entered) return;
    setNudge(true);
    const t = setTimeout(() => setNudge(false), 300);
    return () => clearTimeout(t);
  }, [waiting, swept]);

  // Human tickets show a count instead of a thumbnail: how many direct
  // sub-tickets sit in the board's "Ready for review" column (same predicate
  // as columnOf() in BoardView).
  const readyForReview = ticket.subgraph.tickets.filter(
    (t) => !isTicketDone(t) && t.status === "review",
  ).length;

  // Running a human-review ticket opens its kanban board (the board is the
  // human's interface to that work); the subgraph agents start underneath.
  function run() {
    if (ticket.type === "human_review") {
      useStore.getState().setPath([...path, ticket.id]);
      if (ticket.subgraph.tickets.length === 0) return; // empty board: just open it
    } else if (ticket.subgraph.tickets.length > 0) {
      // Running a subgraph from out here is the toolbar's play from in there,
      // so it gets the toolbar's feedback too. Never for a human ticket: its
      // board opens and this node unmounts, so the beat would go nowhere.
      ackSubgraphRun(path, ticket);
    }
    void runTicket(path, ticket.id);
  }

  // Visible only while the node is hovered or selected; pointer events stay
  // on so dragging a link from where they sit works even mid-fade.
  const handleClass = `!h-2.5 !w-2.5 !border-zinc-400 !bg-zinc-300 transition-opacity duration-150 ${
    selected ? "!opacity-100" : "!opacity-0 group-hover:!opacity-100"
  }`;

  // Resolved once, and published on the node: the drill-in/out flight box wants
  // the colour this card has *unselected*, and this is the only place that knows
  // which of the three rules won.
  const statusBorder = running
    ? borderByStatus.running
    : waiting
      ? borderByStatus.review
      : borderByStatus[shown];

  return (
    <div
      data-zoom-border={statusBorder}
      className={`group relative w-64 rounded-xl border-2 bg-white p-3 pb-2 shadow-lg shadow-zinc-900/10 ${
        appeared ? "ticket-appear " : ""
      }${nudge ? "ticket-waiting-nudge " : ""}${
        selected ? "border-violet-500" : statusBorder
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
          {ticket.type !== "human_review" &&
          (ticket.type === "subgraph" || ticket.subgraph.tickets.length > 0) ? (
            // A ticket that actually holds a graph reads as one whatever its
            // stored type, so projects decomposed before this type existed
            // label correctly without a migration.
            <span
              className="rounded-full bg-pink-100 px-2 py-0.5 text-[10px] font-medium text-pink-400"
              title="Work decomposed into a nested graph"
            >
              Subgraph
            </span>
          ) : ticket.type !== "human_review" ? (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">
              AI
            </span>
          ) : (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
              Human
            </span>
          )}
          {ticket.type === "human_review" && readyForReview > 0 && (
            <span
              className="text-[10px] font-medium text-zinc-700"
              title={`${readyForReview} sub-ticket${readyForReview === 1 ? "" : "s"} ready for your review`}
            >
              {readyForReview} to review
            </span>
          )}
        </div>
        {ticket.type !== "human_review" && ticket.subgraph.tickets.length > 0 && (
          <SubgraphPreview graph={ticket.subgraph} />
        )}
        {running ? (
          <span className="flex items-center gap-1.5">
            {/* Running hides play, but a human ticket's board is reached
                through this node alone — so keep a way in. Navigation only,
                hence an arrow rather than the ▶ that means "run". */}
            {ticket.type === "human_review" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  useStore.getState().setPath([...path, ticket.id]);
                }}
                title="Open the human-interaction window"
                className="text-zinc-400 hover:text-zinc-600"
              >
                <ArrowRightIcon size={14} />
              </button>
            )}
            <StopSquare
              onClick={(e) => {
                e.stopPropagation();
                stopTicket(path, ticket.id);
              }}
            />
            <Spinner />
          </span>
        ) : shown === "todo" ? (
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
        ) : (
          // Waiting: play only — no spinner, no stop, since nothing is running.
          // The border colour carries the state, so no word is printed here.
          (waiting || shown === "review" || shown === "error") && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                run();
              }}
              title="Run"
              className="text-sm leading-none text-emerald-600 hover:text-emerald-500"
            >
              ▶
            </button>
          )
        )}
      </div>
    </div>
  );
}

export const TicketNode = memo(TicketNodeInner);
