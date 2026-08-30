"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import ChatInput from "./ChatInput";
import { ChatMessage, graphAtPath, ticketAtPath } from "@/lib/types";
import { usePanelResize } from "@/lib/useResizable";

const EMPTY: ChatMessage[] = []; // stable fallback so the selector snapshot doesn't churn

/** Side chat with the main agent of the ticket you're inside (the project
 * being the outermost "ticket"). Resumes the ticket's own work session, so
 * the agent knows what it did and can act in the workspace dir. */
export default function ChatPanel() {
  const open = useStore((s) => s.chatOpen);
  const toggleChat = useStore((s) => s.toggleChat);
  const projectName = useStore((s) => s.project.name);
  // The ticket whose graph is open; null at the project root.
  const ticket = useStore((s) =>
    s.path.length === 0
      ? null
      : ticketAtPath(s.project.graph, s.path.slice(0, -1), s.path[s.path.length - 1])
  );
  const rootChat = useStore((s) => s.project.chat ?? EMPTY);
  const messages = ticket ? ticket.chat ?? EMPTY : rootChat;
  const scopeTitle = ticket ? ticket.title : projectName;
  const ticketRunning = ticket?.status === "running";

  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const { width, ref: panelRef, handleProps } = usePanelResize();
  const busy = pending || ticketRunning;

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, pending, open]);

  if (!open) return null;

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setPending(true);

    // Capture the scope at send time, so the reply lands on the right ticket
    // even if the user navigates away while the agent works.
    const s = useStore.getState();
    const parent = s.path.slice(0, -1);
    const id = s.path[s.path.length - 1];
    const t = s.path.length ? ticketAtPath(s.project.graph, parent, id) : null;

    const append = (msg: ChatMessage, sessionId?: string) => {
      const cur = useStore.getState();
      if (t) {
        cur.updateTicket(parent, id, (x) => ({
          ...x,
          chat: [...(x.chat ?? []), msg],
          ...(sessionId ? { sessionId } : {}),
        }));
      } else {
        cur.setProject({
          chat: [...(cur.project.chat ?? []), msg],
          ...(sessionId ? { chatSessionId: sessionId } : {}),
        });
      }
    };
    append({ role: "user", text });

    const g = graphAtPath(s.project.graph, s.path);
    const graphSummary =
      g?.tickets
        .map(
          (x) =>
            `- ${x.title} [${x.status}]${
              x.description ? `: ${x.description.slice(0, 300)}` : ""
            }`
        )
        .join("\n") ?? "";

    let reply: string;
    let sessionId: string | undefined;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId: t ? t.sessionId : s.project.chatSessionId,
          workspaceDir: s.project.workspaceDir,
          projectName: s.project.name,
          ticketTitle: t?.title,
          ticketDescription: t?.description,
          graphSummary,
        }),
      });
      const data = await res.json();
      reply = data.text ?? data.error ?? `Request failed (${res.status})`;
      sessionId = data.sessionId;
    } catch (err) {
      reply = String(err);
    }
    append({ role: "agent", text: reply }, sessionId);
    setPending(false);
  }

  return (
    <aside
      ref={panelRef}
      style={{ width }}
      className="relative shrink-0 flex flex-col overflow-hidden border-l border-zinc-200 bg-white"
    >
      <div {...handleProps} title="Drag to resize" />
      <div className="flex items-center gap-2 p-3 border-b border-zinc-200">
        <span className="min-w-0 truncate font-medium" title={scopeTitle}>
          {scopeTitle}
        </span>
        <button
          className="ml-auto text-zinc-400 hover:text-zinc-700"
          title="Close"
          onClick={toggleChat}
        >
          ✕
        </button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.map((m, i) =>
          m.role === "user" ? (
            <p
              key={i}
              className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm text-zinc-700 whitespace-pre-wrap shadow-inner"
            >
              <span className="text-zinc-400">&gt; </span>
              {m.text}
            </p>
          ) : (
            <p
              key={i}
              className="mr-8 rounded-lg bg-zinc-100 px-3 py-2 font-mono text-sm text-zinc-800 whitespace-pre-wrap"
            >
              {m.text}
            </p>
          )
        )}
        {pending && (
          <p className="mr-8 rounded-lg bg-zinc-100 px-3 py-2 font-mono text-sm text-zinc-500 animate-pulse">
            Working…
          </p>
        )}
      </div>

      <div className="p-3 border-t border-zinc-200">
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={send}
          disabled={busy}
          placeholder={
            ticketRunning
              ? "The ticket's agent is running…"
              : pending
                ? "The agent is working…"
                : "Ask the agent…"
          }
        />
      </div>
    </aside>
  );
}
