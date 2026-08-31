"use client";

import dynamic from "next/dynamic";
import { useEffect, useSyncExternalStore } from "react";
import BoardView from "@/components/BoardView";
import ChatPanel from "@/components/ChatPanel";
import TicketPanel from "@/components/TicketPanel";
import Toolbar from "@/components/Toolbar";
import { useStore } from "@/lib/store";
import { openProject, startAutosave } from "@/lib/sync";
import { ticketAtPath } from "@/lib/types";

const GraphCanvas = dynamic(
  () => import("@/components/GraphCanvas").then((m) => m.GraphCanvas),
  { ssr: false }
);
const ProjectPicker = dynamic(() => import("@/components/ProjectPicker"), { ssr: false });

const emptySubscribe = () => () => {};

export default function Home() {
  // The store persists to localStorage; render only on the client to avoid
  // hydrating server HTML built from the default (empty) project.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
  const projectId = useStore((s) => s.projectId);
  const projectLoaded = useStore((s) => s.projectLoaded);
  const depth = useStore((s) => s.path.length);
  // A human-review ticket's subgraph opens as a kanban board, not a canvas.
  const showBoard = useStore((s) => {
    if (s.path.length === 0) return false;
    const t = ticketAtPath(
      s.project.graph,
      s.path.slice(0, -1),
      s.path[s.path.length - 1]
    );
    return t?.type === "human_review";
  });
  const boardKey = useStore((s) => s.path.join("/"));

  useEffect(() => {
    startAutosave();
  }, []);

  // Re-fetch the persisted project on load (localStorage only keeps the id).
  useEffect(() => {
    if (mounted && projectId && !projectLoaded) void openProject(projectId);
  }, [mounted, projectId, projectLoaded]);

  if (!mounted) return <div className="h-screen bg-zinc-50" />;

  if (!projectId || !projectLoaded) {
    return (
      <div className="h-screen flex flex-col bg-zinc-50 text-zinc-900">
        {projectId ? (
          <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">
            Loading project…
          </div>
        ) : (
          <ProjectPicker />
        )}
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-50 text-zinc-900">
      <Toolbar />
      <div className="flex-1 flex min-h-0">
        <main className="flex-1 relative min-w-0">
          {/* Clip the view to the innermost depth frame so tickets don't
              slide under the layer borders. Navigating swaps what is in here
              instantly, hidden behind the travelling card (see
              `lib/view-zoom.ts`) — the view itself never animates, so a canvas
              mounts at its real size and measures its arrows correctly. */}
          <div className="absolute overflow-hidden rounded-lg" style={{ inset: 3 + depth * 4 }}>
            {showBoard ? <BoardView key={boardKey} /> : <GraphCanvas />}
          </div>
          {/* One nested outline per level — the open project itself counts as
              one level of the meta-graph, so root shows a single frame. The
              frames are the chrome that says how deep you are, so they hold
              still while the view travels; only their colour eases, so the
              hairline that was innermost doesn't flick as it hands over. */}
          {Array.from({ length: depth + 1 }, (_, i) => (
            <div
              key={i}
              aria-hidden
              className={`pointer-events-none absolute z-10 rounded-lg border transition-colors duration-200 ${
                i === depth ? "border-zinc-400" : "border-zinc-300"
              }`}
              style={{ inset: 3 + i * 4 }}
            />
          ))}
        </main>
        <TicketPanel />
        <ChatPanel />
      </div>
    </div>
  );
}
