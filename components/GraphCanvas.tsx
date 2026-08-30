"use client";

import { layoutGraph } from "@/lib/layout";
import { useStore } from "@/lib/store";
import { graphAtPath, TicketStatus, wouldCreateCycle } from "@/lib/types";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo } from "react";
import { TicketNode, type TicketNodeType } from "./TicketNode";

const nodeTypes: NodeTypes = { ticket: TicketNode };

const minimapColor: Record<TicketStatus, string> = {
  todo: "#d4d4d8",
  running: "#60a5fa",
  review: "#fbbf24",
  done: "#10b981",
  error: "#ef4444",
};

export function GraphCanvas() {
  const project = useStore((s) => s.project);
  const path = useStore((s) => s.path);
  const selectedId = useStore((s) => s.selectedId);
  const { setPath, select, addEdge, removeEdge, removeTicket, updateTicket } =
    useStore.getState();

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

  const nodes: TicketNodeType[] = useMemo(() => {
    if (!graph) return [];
    return graph.tickets.map((t) => ({
      id: t.id,
      type: "ticket" as const,
      position: t.position ?? fallbackPositions.get(t.id) ?? { x: 0, y: 0 },
      data: { ticket: t, path },
      selected: t.id === selectedId,
    }));
  }, [graph, fallbackPositions, path, selectedId]);

  const edges: Edge[] = useMemo(() => {
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

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!graph || !conn.source || !conn.target) return;
      if (wouldCreateCycle(graph, conn.source, conn.target)) return;
      addEdge(path, { id: crypto.randomUUID(), source: conn.source, target: conn.target });
    },
    [graph, path, addEdge]
  );

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="light"
        fitView
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={["Backspace", "Delete"]}
        onConnect={onConnect}
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
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) =>
            minimapColor[(n as TicketNodeType).data.ticket.status] ?? "#d4d4d8"
          }
          maskColor="rgba(250, 250, 250, 0.7)"
          bgColor="#f4f4f5"
        />
      </ReactFlow>
      {graph && graph.tickets.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
          No tickets yet — add one, or let AI populate the graph
        </div>
      )}
    </div>
  );
}
