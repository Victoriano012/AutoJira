"use client";

import { useEffect, useRef, useState } from "react";
import { sendFeedback } from "@/lib/runner";
import { useStore } from "@/lib/store";
import ChatInput from "./ChatInput";
import { usePanelResize, useSplitResize } from "@/lib/useResizable";
import { graphAtPath } from "@/lib/types";
import ConfirmDialog from "./ConfirmDialog";
import TicketDetails, { TicketDetailsHeader } from "./TicketDetails";
import TrashIcon from "./TrashIcon";

export default function TicketPanel() {
  const project = useStore((s) => s.project);
  const path = useStore((s) => s.path);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const removeTicket = useStore((s) => s.removeTicket);

  const [feedback, setFeedback] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const { width, ref: panelRef, handleProps } = usePanelResize();
  const {
    height: logHeight,
    ref: splitRef,
    handleProps: splitHandleProps,
  } = useSplitResize();

  const graph = graphAtPath(project.graph, path);
  const ticket = graph?.tickets.find((t) => t.id === selectedId) ?? null;
  const logLength = ticket?.log?.length ?? 0;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logLength, selectedId]);

  if (!graph || !ticket) return null;

  function send() {
    if (!ticket || !feedback.trim()) return;
    void sendFeedback(path, ticket.id, feedback.trim());
    setFeedback("");
  }

  return (
    <aside
      ref={panelRef}
      style={{ width }}
      className="relative shrink-0 flex flex-col overflow-hidden border-l border-zinc-200 bg-white"
    >
      <div {...handleProps} title="Drag to resize" />
      <div className="shrink-0 flex items-center gap-2 p-3">
        <TicketDetailsHeader ticket={ticket} path={path}>
          <button
            className="text-[#d64545] hover:text-red-700"
            title="Delete ticket"
            onClick={() => setConfirmDelete(true)}
          >
            <TrashIcon />
          </button>
          <button
            className="text-zinc-400 hover:text-zinc-700"
            title="Close"
            onClick={() => select(null)}
          >
            ✕
          </button>
        </TicketDetailsHeader>
      </div>

      <div ref={splitRef} className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        <TicketDetails ticket={ticket} path={path} />
      </div>

      <div {...splitHandleProps} title="Drag to resize" />

      <div
        ref={logRef}
        style={{ height: logHeight }}
        className="shrink-0 max-h-[70%] overflow-y-auto p-3 space-y-2"
      >
        {(ticket.log ?? []).map((entry, i) => {
          switch (entry.kind) {
            case "tool":
              return (
                <p key={i} className="text-xs font-mono text-zinc-500">
                  ⚙ {entry.text}
                </p>
              );
            case "user":
              return (
                <p
                  key={i}
                  className="bg-zinc-100 px-2 py-1 font-mono text-sm text-zinc-700 whitespace-pre-wrap"
                >
                  <span className="text-zinc-400">&gt; </span>
                  {entry.text}
                </p>
              );
            case "error":
              // A user-requested stop isn't a failure — show it like info.
              return entry.text.startsWith("Stopped by user") ? (
                <p key={i} className="font-mono text-xs text-zinc-500 italic">
                  {entry.text}
                </p>
              ) : (
                <p key={i} className="font-mono text-sm text-red-600 whitespace-pre-wrap">
                  {entry.text}
                </p>
              );
            case "info":
              return (
                <p key={i} className="font-mono text-xs text-zinc-500 italic">
                  {entry.text}
                </p>
              );
            default:
              return (
                <p key={i} className="font-mono text-sm text-zinc-800 whitespace-pre-wrap">
                  {entry.text}
                </p>
              );
          }
        })}
      </div>
      </div>

      <div className="shrink-0 p-3">
        <ChatInput
          value={feedback}
          onChange={setFeedback}
          onSend={send}
          placeholder="Tell the AI what to change…"
          sendTitle="Send — the AI picks the ticket back up right away"
        />
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete ticket?"
          message={`“${ticket.title}” will be removed from the graph.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            setConfirmDelete(false);
            removeTicket(path, ticket.id);
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </aside>
  );
}
