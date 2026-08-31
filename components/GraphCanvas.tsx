"use client";

import { layoutGraph, NODE_WIDTH } from "@/lib/layout";
import { useStore } from "@/lib/store";
import { rememberedViewport, rememberViewport } from "@/lib/viewport-memory";
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
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TicketNode, type TicketNodeType } from "./TicketNode";
import { useBackSwipe } from "./useBackSwipe";

const nodeTypes: NodeTypes = { ticket: TicketNode };

/** Long enough to read as movement, short enough to accompany the panel. */
const PAN_MS = 220;

/** A double-click opens the ticket's subgraph, and its first click selects —
 * which opens the details panel, takes its width out of the canvas and leaves
 * a right-hand ticket sitting underneath the panel, so the second click lands
 * on the panel instead of the ticket. Selecting therefore waits this long:
 * nothing covers or moves the ticket until the double-click window has passed.
 * Covers a comfortable double-click without the panel feeling sluggish. */
const DOUBLE_CLICK_GRACE_MS = 260;

/** Keeps the selected ticket clear of the details panel. The panel takes its
 * width out of the canvas, so the canvas' own right edge is the panel's left
 * edge: a ticket reaching past it — by a sliver or entirely — is panned
 * horizontally until it sits in the middle of what is left, and panned back
 * when the panel closes. The way back is clamped: whatever the user did to the
 * graph meanwhile, the ticket never lands further right than where it started.
 * Rendered inside <ReactFlow> so it can use the flow instance. */
function PanForPanel({ areaRef }: { areaRef: React.RefObject<HTMLDivElement | null> }) {
  const selectedId = useStore((s) => s.selectedId);
  const { getNode, getViewport, setViewport } = useReactFlow();
  // The pan in force for the current selection: where the viewport sat before
  // it, and where we last sent it. Both are x only — y and zoom are untouched.
  const pan = useRef<{ id: string; from: number; to: number } | null>(null);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : PAN_MS;
    const move = (x: number) => {
      const v = getViewport();
      if (Math.abs(x - v.x) >= 0.5) setViewport({ ...v, x }, { duration });
    };

    if (!selectedId) {
      // Closed: undo our pan, but never past the ticket's starting position —
      // if the user panned it further left meanwhile, keep their offset.
      const p = pan.current;
      pan.current = null;
      if (p) move(p.from + Math.min(getViewport().x - p.to, 0));
      return;
    }

    const centre = () => {
      const node = getNode(selectedId);
      if (!node) return;
      const v = getViewport();
      const width = (node.measured?.width ?? NODE_WIDTH) * v.zoom;
      const left = v.x + node.position.x * v.zoom;
      const held = pan.current?.id === selectedId ? pan.current : null;
      if (!held && left + width <= area.clientWidth) {
        // Fully visible: leave it be. Any pan held for an earlier selection is
        // dropped rather than reversed on close — reversing it would shove the
        // ticket the user is actually looking at off to the right.
        pan.current = null;
        return;
      }
      // Independent of the current viewport, so recomputing mid-animation
      // (a panel resize) aims at the same place instead of drifting.
      const to = area.clientWidth / 2 - width / 2 - node.position.x * v.zoom;
      pan.current = { id: selectedId, from: held?.from ?? v.x, to };
      move(to);
    };

    centre();
    // The panel is drag-resizable: follow it while it is open.
    const ro = new ResizeObserver(centre);
    ro.observe(area);
    return () => ro.disconnect();
  }, [selectedId, areaRef, getNode, getViewport, setViewport]);

  return null;
}

export function GraphCanvas() {
  const project = useStore((s) => s.project);
  const projectId = useStore((s) => s.projectId);
  const path = useStore((s) => s.path);
  const selectedId = useStore((s) => s.selectedId);
  const { setPath, select, addEdge, removeEdge, removeTicket, updateTicket } =
    useStore.getState();

  // Swipe back one layer — shared with the human-review board, which renders
  // instead of this canvas and needs the same gesture.
  const wrapperRef = useRef<HTMLDivElement>(null);
  useBackSwipe(wrapperRef);

  // Selecting is held back for the double-click window (see the constant above);
  // deselecting has no such problem and stays immediate.
  const selectTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(selectTimer.current), []);

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
      const source = graph.tickets.find((t) => t.id === e.source);
      const passed = source !== undefined && satisfiesDependents(source);
      const color = passed ? "#34a26a" : "#a1a1aa";
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        style: { stroke: color, strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color },
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

  // Identity of the graph on screen: what the canvas remounts on, and what its
  // remembered pan/zoom is filed under. Read once per graph — every move writes
  // this key back, so a later read would be the position being left rather than
  // the one to come back to.
  const graphKey = `${projectId}:${path.join("/")}`;
  const start = useMemo(() => rememberedViewport(graphKey), [graphKey]);

  return (
    <div ref={wrapperRef} className="relative h-full w-full overscroll-x-none">
      <ReactFlow
        // Remount when the viewed graph changes (project switch, subgraph
        // navigation) so the mount-time fitView recenters on it.
        key={graphKey}
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        colorMode="light"
        // A graph already visited this page-lifetime opens where it was left
        // (see `lib/viewport-memory.ts`), and only a first visit fits.
        // `defaultViewport` rather than a setViewport once mounted: it is the
        // transform the first paint gets, and a queued fitView would in any
        // case run after the nodes are measured — after any effect of ours.
        fitView={!start}
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        defaultViewport={start}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={["Backspace", "Delete"]}
        onConnect={onConnect}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onMoveEnd={(_, viewport) => rememberViewport(graphKey, viewport)}
        onNodeDragStop={(_, node) =>
          updateTicket(path, node.id, (t) => ({ ...t, position: node.position }))
        }
        onNodeClick={(_, node) => {
          clearTimeout(selectTimer.current);
          selectTimer.current = window.setTimeout(
            () => select(node.id),
            DOUBLE_CLICK_GRACE_MS
          );
        }}
        onNodeDoubleClick={(_, node) => {
          clearTimeout(selectTimer.current);
          setPath([...path, node.id]);
        }}
        onPaneClick={() => {
          clearTimeout(selectTimer.current);
          select(null);
        }}
        onNodesDelete={(deleted) => deleted.forEach((n) => removeTicket(path, n.id))}
        onEdgesDelete={(deleted) => deleted.forEach((e) => removeEdge(path, e.id))}
      >
        <PanForPanel areaRef={wrapperRef} />
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
