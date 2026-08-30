"use client";

import { useEffect, useState } from "react";
import { autoLayout } from "@/lib/layout";
import { useStore } from "@/lib/store";
import {
  GraphEdge,
  graphAtPath,
  newTicket,
  Ticket,
  ticketAtPath,
  TicketType,
} from "@/lib/types";

interface GeneratedTicket {
  title: string;
  description: string;
  type: TicketType;
  blocking: boolean;
  dependsOn: number[];
}

export default function PopulateModal({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const path = useStore((s) => s.path);
  const setProject = useStore((s) => s.setProject);
  const updateGraph = useStore((s) => s.updateGraph);

  const atRoot = path.length === 0;
  const currentTicket = atRoot
    ? null
    : ticketAtPath(project.graph, path.slice(0, -1), path[path.length - 1]);

  const [description, setDescription] = useState(
    atRoot ? project.description : currentTicket?.description ?? ""
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    if (!description.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/populate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          context: currentTicket?.title,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      const data = (await res.json()) as { tickets: GeneratedTicket[] };

      const tickets: Ticket[] = data.tickets.map((g) =>
        newTicket({
          title: g.title,
          description: g.description,
          type: g.type,
          blocking: g.type === "human_review" ? g.blocking : true,
        })
      );
      const edges: GraphEdge[] = [];
      data.tickets.forEach((g, i) => {
        for (const d of g.dependsOn) {
          if (d !== i && tickets[d]) {
            edges.push({
              id: crypto.randomUUID(),
              source: tickets[d].id,
              target: tickets[i].id,
            });
          }
        }
      });
      const graph = { tickets, edges };
      const positions = autoLayout(graph);
      for (const t of tickets) t.position = positions.get(t.id) ?? null;

      const existing = graphAtPath(project.graph, path);
      if (
        existing &&
        existing.tickets.length > 0 &&
        !confirm("Replace the current tickets in this graph?")
      ) {
        setLoading(false);
        return;
      }
      updateGraph(path, () => graph);
      if (atRoot) setProject({ description });
      onClose();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white border border-zinc-200 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">✨ Populate with AI</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Describe the {atRoot ? "project" : `work for “${currentTicket?.title}”`};
          the AI will break it into a graph of tickets with dependencies.
        </p>
        <textarea
          className="mt-4 w-full min-h-40 rounded-lg bg-zinc-50 border border-zinc-300 p-3 text-sm outline-none focus:border-zinc-500"
          placeholder="What should be built?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          autoFocus
        />
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-1.5 text-sm bg-zinc-200 hover:bg-zinc-300"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-lg px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
            onClick={submit}
            disabled={loading || !description.trim()}
          >
            {loading ? "Generating…" : "Generate tickets"}
          </button>
        </div>
      </div>
    </div>
  );
}
