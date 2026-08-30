"use client";

import { useEffect, useRef, useState } from "react";
import {
  approveTicket,
  runTicket,
  sendFeedback,
  stopTicket,
} from "@/lib/runner";
import { useStore } from "@/lib/store";
import {
  dependenciesOf,
  graphAtPath,
  isTicketDone,
  TicketStatus,
} from "@/lib/types";
import AttachmentEditor from "./AttachmentEditor";

const statusColor: Record<TicketStatus, string> = {
  todo: "bg-zinc-500",
  running: "bg-blue-400 animate-pulse",
  review: "bg-amber-400",
  done: "bg-emerald-400",
  error: "bg-red-400",
};

const statusText: Record<TicketStatus, string> = {
  todo: "To do",
  running: "Running",
  review: "Awaiting review",
  done: "Done",
  error: "Error",
};

const statusTextColor: Record<TicketStatus, string> = {
  todo: "text-zinc-400",
  running: "text-blue-400",
  review: "text-amber-400",
  done: "text-emerald-400",
  error: "text-red-400",
};

export default function TicketPanel() {
  const project = useStore((s) => s.project);
  const path = useStore((s) => s.path);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const updateTicket = useStore((s) => s.updateTicket);
  const removeTicket = useStore((s) => s.removeTicket);

  const [feedback, setFeedback] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  const graph = graphAtPath(project.graph, path);
  const ticket = graph?.tickets.find((t) => t.id === selectedId) ?? null;
  const logLength = ticket?.log.length ?? 0;

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logLength, selectedId]);

  if (!graph || !ticket) return null;

  const deps = dependenciesOf(graph, ticket.id);
  const canChat =
    !!ticket.sessionId &&
    (ticket.status === "review" ||
      ticket.status === "done" ||
      ticket.status === "error");

  function send() {
    if (!ticket || !feedback.trim()) return;
    void sendFeedback(path, ticket.id, feedback.trim());
    setFeedback("");
  }

  return (
    <aside className="w-96 shrink-0 flex flex-col overflow-hidden border-l border-zinc-200 bg-white">
      <div className="flex items-center gap-2 p-3 border-b border-zinc-200">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusColor[ticket.status]}`} />
        <input
          className="flex-1 min-w-0 bg-transparent font-medium outline-none rounded px-1 focus:bg-zinc-100"
          value={ticket.title}
          onChange={(e) =>
            updateTicket(path, ticket.id, (t) => ({ ...t, title: e.target.value }))
          }
        />
        <button
          className="text-zinc-400 hover:text-red-500"
          title="Delete ticket"
          onClick={() => {
            if (confirm(`Delete ticket “${ticket.title}”?`)) {
              removeTicket(path, ticket.id);
            }
          }}
        >
          🗑
        </button>
        <button
          className="text-zinc-400 hover:text-zinc-700"
          title="Close"
          onClick={() => select(null)}
        >
          ✕
        </button>
      </div>

      <div className="p-3 space-y-3 border-b border-zinc-200">
        <div className="flex items-center gap-2 text-sm">
          <select
            className="rounded-lg bg-white border border-zinc-300 px-2 py-1 text-sm outline-none"
            value={ticket.type}
            onChange={(e) =>
              updateTicket(path, ticket.id, (t) => ({
                ...t,
                type: e.target.value as typeof t.type,
              }))
            }
          >
            <option value="ai">🤖 AI</option>
            <option value="human_review">👤 Human review</option>
          </select>
          <span className={statusTextColor[ticket.status]}>
            {statusText[ticket.status]}
          </span>
          <span className="ml-auto flex gap-1">
            {ticket.status !== "done" ? (
              <button
                className="rounded px-2 py-1 text-xs bg-zinc-200 hover:bg-zinc-300"
                onClick={() =>
                  updateTicket(path, ticket.id, (t) => ({ ...t, status: "done" }))
                }
              >
                Mark done
              </button>
            ) : (
              <button
                className="rounded px-2 py-1 text-xs bg-zinc-200 hover:bg-zinc-300"
                onClick={() =>
                  updateTicket(path, ticket.id, (t) => ({ ...t, status: "todo" }))
                }
              >
                Reopen
              </button>
            )}
          </span>
        </div>

        {ticket.type === "human_review" && (
          <label className="flex items-start gap-2 text-xs text-zinc-600 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 accent-amber-500"
              checked={ticket.blocking !== false}
              onChange={(e) =>
                updateTicket(path, ticket.id, (t) => ({
                  ...t,
                  blocking: e.target.checked,
                }))
              }
            />
            <span>
              Blocks dependents until approved
              <span className="block text-zinc-400">
                Unchecked: dependents start right after the AI finishes, on a new
                git branch, while you review this one.
              </span>
            </span>
          </label>
        )}

        <textarea
          className="w-full min-h-28 rounded-lg bg-white border border-zinc-300 p-2 text-sm outline-none focus:border-zinc-500"
          placeholder="Describe what this ticket should accomplish…"
          value={ticket.description}
          onChange={(e) =>
            updateTicket(path, ticket.id, (t) => ({
              ...t,
              description: e.target.value,
            }))
          }
        />

        <AttachmentEditor
          label="Context files"
          attachments={ticket.attachments ?? []}
          onChange={(attachments) =>
            updateTicket(path, ticket.id, (t) => ({ ...t, attachments }))
          }
        />

        {deps.length > 0 && (
          <div className="text-xs text-zinc-600">
            <span className="text-zinc-500">Depends on:</span>
            {deps.map((d) => (
              <div key={d.id} className="ml-1">
                {isTicketDone(d) ? "✓" : "○"} {d.title}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          {ticket.status === "running" ? (
            <button
              className="rounded-lg px-3 py-1.5 text-sm bg-red-100 hover:bg-red-200 text-red-700"
              onClick={() => stopTicket(path, ticket.id)}
            >
              ◼ Stop
            </button>
          ) : (
            <button
              className="rounded-lg px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 text-white"
              onClick={() => void runTicket(path, ticket.id)}
            >
              ▶ Run{ticket.subgraph.tickets.length > 0 ? " subgraph" : ""}
            </button>
          )}
        </div>

        {ticket.status === "review" && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-sm text-amber-700 font-medium">
              Awaiting human review
            </p>
            <p className="mt-1 text-xs text-amber-700/80">
              {ticket.blocking === false
                ? "Non-blocking: dependent tickets continue on a separate git branch while you review. Send feedback below or approve."
                : "Test the result, send feedback below, or approve to unblock dependent tickets."}
            </p>
            <button
              className="mt-2 rounded-lg px-3 py-1.5 text-sm bg-amber-500 hover:bg-amber-400 text-white font-medium"
              onClick={() => approveTicket(path, ticket.id)}
            >
              ✔ Approve
            </button>
          </div>
        )}
      </div>

      {ticket.resultSummary && (
        <div className="mx-3 mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-2 text-sm text-zinc-700 max-h-40 overflow-y-auto">
          <p className="text-xs text-zinc-500 mb-1">Latest result</p>
          <p className="whitespace-pre-wrap">{ticket.resultSummary}</p>
        </div>
      )}

      <div ref={logRef} className="flex-1 overflow-y-auto p-3 space-y-2">
        {ticket.log.length === 0 && (
          <p className="text-xs text-zinc-400">No activity yet.</p>
        )}
        {ticket.log.map((entry, i) => {
          switch (entry.kind) {
            case "tool":
              return (
                <p key={i} className="text-xs font-mono text-zinc-500">
                  ⚙ {entry.text}
                </p>
              );
            case "user":
              return (
                <p key={i} className="text-sm text-sky-700 whitespace-pre-wrap">
                  You: {entry.text}
                </p>
              );
            case "error":
              return (
                <p key={i} className="text-sm text-red-600 whitespace-pre-wrap">
                  {entry.text}
                </p>
              );
            case "info":
              return (
                <p key={i} className="text-xs text-zinc-500 italic">
                  {entry.text}
                </p>
              );
            default:
              return (
                <p key={i} className="text-sm text-zinc-800 whitespace-pre-wrap">
                  {entry.text}
                </p>
              );
          }
        })}
      </div>

      {canChat && (
        <div className="p-3 border-t border-zinc-200">
          <textarea
            className="w-full rounded-lg bg-white border border-zinc-300 p-2 text-sm outline-none focus:border-zinc-500"
            rows={2}
            placeholder="Give the AI feedback on this ticket…"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            }}
          />
          <button
            className="mt-1 rounded-lg px-3 py-1.5 text-sm bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50"
            onClick={send}
            disabled={!feedback.trim()}
          >
            Send feedback
          </button>
        </div>
      )}
    </aside>
  );
}
