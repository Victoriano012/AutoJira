"use client";

import { runTicket, stopTicket } from "@/lib/runner";
import { Ticket, ticketProgress, TicketStatus } from "@/lib/types";
import { Handle, NodeProps, Position, type Node } from "@xyflow/react";
import { memo } from "react";

export type TicketNodeType = Node<{ ticket: Ticket; path: string[] }, "ticket">;

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

function TicketNodeInner({ data, selected }: NodeProps<TicketNodeType>) {
  const { ticket, path } = data;
  const progress = ticketProgress(ticket);

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

      <div className="flex items-center justify-between gap-2">
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
            Human review{ticket.blocking === false ? " ⇢" : ""}
          </span>
        )}
        {ticket.status === "todo" ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void runTicket(path, ticket.id);
            }}
            title="Run"
            className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-[9px] text-white hover:bg-emerald-700"
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

      <div className="mt-1.5 line-clamp-2 text-sm font-medium text-zinc-900">
        {ticket.title}
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
          ) : ticket.status !== "todo" ? (
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
        {progress && (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600">
            {progress.done}/{progress.total} subtasks
          </span>
        )}
      </div>
    </div>
  );
}

export const TicketNode = memo(TicketNodeInner);
