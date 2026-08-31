"use client";

import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import BoardView from "@/components/BoardView";
import ChatPanel from "@/components/ChatPanel";
import TicketPanel from "@/components/TicketPanel";
import Toolbar from "@/components/Toolbar";
import { consumeViewZoom, useStore } from "@/lib/store";
import { openProject, startAutosave } from "@/lib/sync";
import { ticketAtPath } from "@/lib/types";

const GraphCanvas = dynamic(
  () => import("@/components/GraphCanvas").then((m) => m.GraphCanvas),
  { ssr: false }
);
const ProjectPicker = dynamic(() => import("@/components/ProjectPicker"), { ssr: false });

const emptySubscribe = () => () => {};

/** Matches the `.view-zoom` transition in globals.css. */
const ZOOM_MS = 240;

/**
 * The clipped frame the current view lives in. On every navigation it grows out
 * of the card that was opened, or shrinks back into the card being returned to
 * — the rect comes from `setPath`, the only moment the outgoing view is still on
 * screen to be measured (see `consumeViewZoom`).
 *
 * Only the frame's own `transform` moves, never its size: scaling the box would
 * relayout a React Flow canvas or a four-column board on every frame. Its
 * children measure their untransformed box, so they lay out once, at the size
 * they will end at, and the transform just carries them there.
 *
 * Rendered below the mount guard so this layout effect never runs on the server.
 */
function ZoomFrame({ inset, children }: { inset: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const pathKey = useStore((s) => s.path.join("/"));

  useLayoutEffect(() => {
    const el = ref.current;
    const zoom = consumeViewZoom();
    if (!el || !zoom) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return;

    if (zoom.rect) {
      const dx = zoom.rect.left - box.left;
      const dy = zoom.rect.top - box.top;
      const sx = zoom.rect.width / box.width;
      const sy = zoom.rect.height / box.height;
      el.style.transformOrigin = "0 0";
      el.style.transform =
        zoom.dir === "in"
          ? `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`
          : `translate(${-dx / sx}px, ${-dy / sy}px) scale(${1 / sx}, ${1 / sy})`;
    } else {
      // No card to grow out of — a reload, or a breadcrumb jump past the level
      // whose rect we kept. Scale from the middle rather than from a guess.
      el.style.transformOrigin = "50% 50%";
      el.style.transform = `scale(${zoom.dir === "in" ? 0.9 : 1.1})`;
    }
    el.style.opacity = "0";

    // One frame with the start state committed and no transition, then release.
    const raf = requestAnimationFrame(() => {
      el.classList.add("view-zoom");
      if (zoom.dir === "out") el.classList.add("view-zoom-out");
      el.style.transform = "";
      el.style.opacity = "";
    });
    const clear = () => {
      el.classList.remove("view-zoom", "view-zoom-out");
      el.style.transform = "";
      el.style.opacity = "";
      el.style.transformOrigin = "";
    };
    const done = window.setTimeout(clear, ZOOM_MS + 60);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
      clear();
    };
  }, [pathKey]);

  return (
    <div ref={ref} className="absolute overflow-hidden rounded-lg" style={{ inset }}>
      {children}
    </div>
  );
}

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
              slide under the layer borders. */}
          <ZoomFrame inset={3 + depth * 4}>
            {showBoard ? <BoardView key={boardKey} /> : <GraphCanvas />}
          </ZoomFrame>
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
