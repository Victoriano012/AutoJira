"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import TicketPanel from "@/components/TicketPanel";
import Toolbar from "@/components/Toolbar";

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
  if (!mounted) return <div className="h-screen bg-zinc-50" />;

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
