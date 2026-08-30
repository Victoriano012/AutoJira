import dagre from "dagre";
import { TicketGraph } from "./types";

export const NODE_WIDTH = 260;
export const NODE_HEIGHT = 120;

type Point = { x: number; y: number };

function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (a: Point, b: Point, c: Point) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return (
    d(p3, p4, p1) * d(p3, p4, p2) < 0 && d(p1, p2, p3) * d(p1, p2, p4) < 0
  );
}

function countCrossings(centers: Map<string, Point>, graph: TicketGraph): number {
  const es = graph.edges;
  let n = 0;
  for (let i = 0; i < es.length; i++) {
    for (let j = i + 1; j < es.length; j++) {
      const a = es[i];
      const b = es[j];
      if (
        a.source === b.source || a.source === b.target ||
        a.target === b.source || a.target === b.target
      )
        continue;
      if (
        segmentsCross(
          centers.get(a.source)!, centers.get(a.target)!,
          centers.get(b.source)!, centers.get(b.target)!
        )
      )
        n++;
    }
  }
  return n;
}

/** Dagre's crossing minimization depends on node/edge insertion order and can
 * leave avoidable crossings. Refine with a few barycenter sweeps over its
 * ranks: reorder nodes within each rank (keeping the rank's y slots) toward
 * the mean y of their neighbors, keeping the best result seen. */
function refineOrdering(centers: Map<string, Point>, graph: TicketGraph): Map<string, Point> {
  const byX = new Map<number, string[]>();
  for (const [id, p] of centers) {
    const key = Math.round(p.x);
    const col = byX.get(key);
    if (col) col.push(id);
    else byX.set(key, [id]);
  }
  const columns = [...byX.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids);

  const neighbors = new Map<string, string[]>();
  for (const e of graph.edges) {
    (neighbors.get(e.source) ?? neighbors.set(e.source, []).get(e.source)!).push(e.target);
    (neighbors.get(e.target) ?? neighbors.set(e.target, []).get(e.target)!).push(e.source);
  }

  let best = new Map(centers);
  let bestCrossings = countCrossings(centers, graph);
  for (let iter = 0; iter < 4 && bestCrossings > 0; iter++) {
    const pass = iter % 2 === 0 ? columns : [...columns].reverse();
    for (const ids of pass) {
      const slots = ids.map((id) => centers.get(id)!.y).sort((a, b) => a - b);
      const keys = new Map(
        ids.map((id) => {
          const ns = neighbors.get(id);
          if (!ns || ns.length === 0) return [id, centers.get(id)!.y] as const;
          return [id, ns.reduce((sum, n) => sum + centers.get(n)!.y, 0) / ns.length] as const;
        })
      );
      ids.sort(
        (a, b) => keys.get(a)! - keys.get(b)! || centers.get(a)!.y - centers.get(b)!.y
      );
      ids.forEach((id, i) => centers.set(id, { ...centers.get(id)!, y: slots[i] }));
    }
    const c = countCrossings(centers, graph);
    if (c < bestCrossings) {
      bestCrossings = c;
      best = new Map(centers);
    }
  }
  return best;
}

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

  let centers = new Map<string, Point>();
  for (const t of graph.tickets) {
    const n = g.node(t.id);
    centers.set(t.id, { x: n.x, y: n.y });
  }
  centers = refineOrdering(centers, graph);

  const positions = new Map<string, { x: number; y: number }>();
  for (const [id, c] of centers) {
    // dagre positions are node centers; React Flow wants the top-left corner
    positions.set(id, { x: c.x - NODE_WIDTH / 2, y: c.y - NODE_HEIGHT / 2 });
  }
  return positions;
}

export const autoLayout = layoutGraph;
