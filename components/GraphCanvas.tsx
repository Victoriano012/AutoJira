"use client";

import { layoutGraph } from "@/lib/layout";
import { useStore } from "@/lib/store";
import {
  dependenciesOf,
  graphAtPath,
  satisfiesDependents,
  wouldCreateCycle,
} from "@/lib/types";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TicketNode, type TicketNodeType } from "./TicketNode";

const nodeTypes: NodeTypes = { ticket: TicketNode };

export function GraphCanvas() {
  const project = useStore((s) => s.project);
  const projectId = useStore((s) => s.projectId);
  const path = useStore((s) => s.path);
  const selectedId = useStore((s) => s.selectedId);
  const { setPath, select, addEdge, removeEdge, removeTicket, updateTicket } =
    useStore.getState();

  // Two-finger horizontal swipe (wheel events with dominant deltaX) navigates
  // back one graph layer instead of zooming/panning. Native capture-phase,
  // non-passive listener so we can preventDefault (kills the browser history
  // swipe) and stop React Flow's own wheel handling for the horizontal axis.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const swipe = useRef({ acc: 0, locked: false, timer: 0 });
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // pinch zoom stays as is
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical scroll stays as is
      e.preventDefault();
      e.stopPropagation();
      const s = swipe.current;
      window.clearTimeout(s.timer);
      // one physical swipe = one navigation: stay locked until quiet for 300ms
      s.timer = window.setTimeout(() => {
        s.acc = 0;
        s.locked = false;
      }, 300);
      if (s.locked) return;
      s.acc += e.deltaX;
      // The sign of deltaX for a physical right-swipe flips with the user's
      // scroll-direction setting, so a strong horizontal accumulation in
      // either direction means "go back" — one gesture, one action.
      if (Math.abs(s.acc) > 80) {
        s.locked = true;
        s.acc = 0;
        const st = useStore.getState();
        if (st.path.length > 0) st.setPath(st.path.slice(0, -1));
        else st.closeProject();
      }
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  // Rendered client-only (dynamic ssr:false) and the store hydrates
  // synchronously from localStorage, so no mount guard is needed.
  const graph = graphAtPath(project.graph, path);
  useEffect(() => {
    if (!graph) setPath([]); // stale path (e.g. ticket deleted) — go back to root
  }, [graph, setPath]);

  const fallbackPositions = useMemo(
    () => (graph ? layoutGraph(graph) : new Map<string, { x: number; y: number }>()),
    [graph]
  );

  const storeNodes: TicketNodeType[] = useMemo(() => {
    if (!graph) return [];
    return graph.tickets.map((t) => ({
      id: t.id,
      type: "ticket" as const,
      position: t.position ?? fallbackPositions.get(t.id) ?? { x: 0, y: 0 },
      data: {
        ticket: t,
        path,
        ready: dependenciesOf(graph, t.id).every(satisfiesDependents),
      },
      selected: t.id === selectedId,
    }));
  }, [graph, fallbackPositions, path, selectedId]);

  // Local node state so dragging follows the cursor; the store is only
  // written on drag stop, and storeNodes changes re-sync local state.
  const [nodes, setNodes] = useState(storeNodes);
  useEffect(() => setNodes(storeNodes), [storeNodes]);
  const onNodesChange = useCallback(
    (changes: NodeChange<TicketNodeType>[]) =>
      setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );

  const storeEdges: Edge[] = useMemo(() => {
    if (!graph) return [];
    return graph.edges.map((e) => {
      const target = graph.tickets.find((t) => t.id === e.target);
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: target?.status === "running",
        style: { stroke: "#a1a1aa", strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#a1a1aa" },
      };
    });
  }, [graph]);

  // Same local-state mirror for edges so they can be selected (and then
  // deleted with Backspace/Delete); the store stays the source of truth.
  const [edges, setEdges] = useState(storeEdges);
  useEffect(() => setEdges(storeEdges), [storeEdges]);
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );
  const styledEdges = useMemo(
    () =>
      edges.map((e) =>
        e.selected
          ? {
              ...e,
              style: { stroke: "#8b5cf6", strokeWidth: 2 },
              markerEnd: { type: MarkerType.ArrowClosed, color: "#8b5cf6" },
            }
          : e
      ),
    [edges]
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!graph || !conn.source || !conn.target) return;
      if (wouldCreateCycle(graph, conn.source, conn.target)) return;
      addEdge(path, { id: crypto.randomUUID(), source: conn.source, target: conn.target });
    },
    [graph, path, addEdge]
  );

  return (
    <div ref={wrapperRef} className="relative h-full w-full overscroll-x-none">
      <ReactFlow
        // Remount when the viewed graph changes (project switch, subgraph
        // navigation) so the mount-time fitView recenters on it.
        key={`${projectId}:${path.join("/")}`}
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        colorMode="light"
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={["Backspace", "Delete"]}
        onConnect={onConnect}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={(_, node) =>
          updateTicket(path, node.id, (t) => ({ ...t, position: node.position }))
        }
        onNodeClick={(_, node) => select(node.id)}
        onNodeDoubleClick={(_, node) => setPath([...path, node.id])}
        onPaneClick={() => select(null)}
        onNodesDelete={(deleted) => deleted.forEach((n) => removeTicket(path, n.id))}
        onEdgesDelete={(deleted) => deleted.forEach((e) => removeEdge(path, e.id))}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} color="#d4d4d8" />
        <Controls />
      </ReactFlow>
      {graph && graph.tickets.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
          No tickets yet — add one, or let AI populate the graph
        </div>
      )}
    </div>
  );
}
