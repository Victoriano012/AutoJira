import dagre from "dagre";
import { TicketGraph } from "./types";

export const NODE_WIDTH = 260;
export const NODE_HEIGHT = 120;

/** Dagre left-to-right layout for every ticket in the graph. */
export function layoutGraph(graph: TicketGraph): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", ranksep: 90, nodesep: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const t of graph.tickets) {
    g.setNode(t.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of graph.edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const t of graph.tickets) {
    const n = g.node(t.id);
    // dagre positions are node centers; React Flow wants the top-left corner
    positions.set(t.id, { x: n.x - NODE_WIDTH / 2, y: n.y - NODE_HEIGHT / 2 });
  }
  return positions;
}

export const autoLayout = layoutGraph;
