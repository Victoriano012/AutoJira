"use client";

import { getViewportForBounds, type Node } from "@xyflow/react";
import { useLayoutEffect, useMemo, useState, type RefObject } from "react";

/** The box a project node is taken to occupy (the card is `w-64`, a little
 * narrower); the fit is computed from these, never from measured sizes. */
const NODE_WIDTH = 260;
const NODE_HEIGHT = 120;

/** React Flow's own floor, and the one a graph that already fits keeps. */
const DEFAULT_MIN_ZOOM = 0.5;

/**
 * A canvas' zoom floor, lowered until the whole graph fits inside it.
 *
 * React Flow's floor is a constant, so past a certain size a graph simply
 * cannot be seen whole: the zoom-out stops with tickets still off screen. The
 * floor here is whatever `fitView` would settle on for the nodes currently on
 * the canvas — never above the constant, so a graph that already fits is
 * untouched, and exactly low enough that zooming all the way out is the same
 * view as pressing "fit".
 *
 * `null` until the container has been measured, and the caller renders no
 * canvas before then: React Flow reads `minZoom` once, when its pan/zoom
 * mounts, both to set d3-zoom's scale extent and to clamp `defaultViewport` —
 * a floor arriving a frame later would already have shoved a remembered zoom
 * back up to 0.5.
 */
export function useFitAllMinZoom<T extends Node>(
  nodes: T[],
  container: RefObject<HTMLElement | null>,
  padding: number
): number | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => {
      // A zero-sized container is one that has not been laid out yet, not a
      // canvas to compute a floor from — stay unmeasured and render nothing.
      if (!el.clientWidth || !el.clientHeight) return;
      setSize((prev) =>
        prev?.width === el.clientWidth && prev?.height === el.clientHeight
          ? prev
          : { width: el.clientWidth, height: el.clientHeight }
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [container]);

  // The box the nodes occupy. Walking them is the only part that costs
  // anything, so it is kept to the renders where the nodes actually changed.
  //
  // Not `getNodesBounds`: outside a flow it has no `nodeLookup` to resolve
  // sub-flow parents through, and warns on every call for it — there are no
  // nested nodes here. The sizes are the constants above because the array the
  // picker hands to React Flow carries no measured ones (measurement lives in
  // the flow's own store), and the fit padding covers any slack in the height.
  const bounds = useMemo(() => {
    if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const { position } of nodes) {
      minX = Math.min(minX, position.x);
      minY = Math.min(minY, position.y);
      maxX = Math.max(maxX, position.x);
      maxY = Math.max(maxY, position.y);
    }
    return {
      x: minX,
      y: minY,
      width: maxX - minX + NODE_WIDTH,
      height: maxY - minY + NODE_HEIGHT,
    };
  }, [nodes]);

  return useMemo(() => {
    if (!size) return null;
    // An empty graph has zero-sized bounds and so an infinite fit zoom, which
    // the clamp and the Math.min drop back to the constant on their own.
    const { zoom } = getViewportForBounds(bounds, size.width, size.height, 0, 1, padding);
    return Math.min(DEFAULT_MIN_ZOOM, zoom);
  }, [bounds, size, padding]);
}
