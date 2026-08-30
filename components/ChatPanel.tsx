"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { graphAtPath } from "@/lib/types";

/** Project chat: an agent with the current board's context that works in the
 * workspace dir (run commands, host the site, quick fixes…). */
export default function ChatPanel() {
  const open = useStore((s) => s.chatOpen);
  const toggleChat = useStore((s) => s.toggleChat);
  const messages = useStore((s) => s.project.chat ?? []);

  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, pending, open]);

  if (!open) return null;

  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    setInput("");
    setPending(true);

    const s = useStore.getState();
    s.setProject({ chat: [...(s.project.chat ?? []), { role: "user", text }] });
    const g = graphAtPath(s.project.graph, s.path);
    const graphSummary =
      g?.tickets
        .map(
          (t) =>
            `- ${t.title} [${t.status}]${
              t.description ? `: ${t.description.slice(0, 300)}` : ""
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
          sessionId: s.project.chatSessionId,
          workspaceDir: s.project.workspaceDir,
          projectName: s.project.name,
          graphSummary,
        }),
      });
      const data = await res.json();
      reply = data.text ?? data.error ?? `Request failed (${res.status})`;
      sessionId = data.sessionId;
    } catch (err) {
      reply = String(err);
    }
    const cur = useStore.getState();
    cur.setProject({
      chat: [...(cur.project.chat ?? []), { role: "agent", text: reply }],
      ...(sessionId ? { chatSessionId: sessionId } : {}),
    });
    setPending(false);
  }

  return (
    <aside className="w-96 shrink-0 flex flex-col overflow-hidden border-l border-zinc-200 bg-white">
      <div className="flex items-center gap-2 p-3 border-b border-zinc-200">
        <span className="font-medium">Project chat</span>
        <button
          className="ml-auto text-zinc-400 hover:text-zinc-700"
          title="Close"
          onClick={toggleChat}
        >
          ✕
        </button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.length === 0 && !pending && (
          <p className="text-xs text-zinc-400">
            Ask for anything around the project — the agent knows the current
            tickets and works in the workspace directory (run commands, host
            the site, quick fixes…).
          </p>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <p
              key={i}
              className="ml-8 rounded-lg bg-violet-600 px-3 py-2 text-sm text-white whitespace-pre-wrap"
            >
              {m.text}
            </p>
          ) : (
            <p
              key={i}
              className="mr-8 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-800 whitespace-pre-wrap"
            >
              {m.text}
            </p>
          )
        )}
        {pending && (
          <p className="mr-8 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-500 animate-pulse">
            Working…
          </p>
        )}
      </div>

      <div className="p-3 border-t border-zinc-200">
        <div className="relative">
          <textarea
            className="w-full rounded-lg bg-white border border-zinc-300 p-2 pr-10 text-sm outline-none focus:border-zinc-500 disabled:opacity-50"
            rows={2}
            placeholder={pending ? "The agent is working…" : "Ask the agent…"}
            value={input}
            disabled={pending}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            className="absolute right-2 bottom-3 flex h-7 w-7 items-center justify-center rounded-full bg-zinc-800 text-white hover:bg-zinc-700 disabled:opacity-40"
            onClick={send}
            disabled={pending || !input.trim()}
            title="Send"
          >
            ↑
          </button>
        </div>
      </div>
    </aside>
  );
}
