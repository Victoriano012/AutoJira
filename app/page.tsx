"use client";

import dynamic from "next/dynamic";
import { useEffect, useSyncExternalStore } from "react";
import ProjectPicker from "@/components/ProjectPicker";
import TicketPanel from "@/components/TicketPanel";
import Toolbar from "@/components/Toolbar";
import { useStore } from "@/lib/store";
import { openProject, startAutosave } from "@/lib/sync";

const GraphCanvas = dynamic(
  () => import("@/components/GraphCanvas").then((m) => m.GraphCanvas),
  { ssr: false }
);

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
          <GraphCanvas />
        </main>
        <TicketPanel />
      </div>
    </div>
  );
}
