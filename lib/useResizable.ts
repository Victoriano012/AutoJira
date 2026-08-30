"use client";

import { useCallback, useRef, useState } from "react";

/** Shared drag-to-resize core: the handle sits at the container's near edge
 * (left for "x", top for "y") and the size is measured from the far edge. */
function useDragSize<T extends HTMLElement>(
  axis: "x" | "y",
  initial: number,
  min: number,
  maxOf: (rect: DOMRect | undefined) => number,
  className: string
) {
  const [size, setSize] = useState(initial);
  const ref = useRef<T>(null);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const rect = ref.current?.getBoundingClientRect();
      const far =
        axis === "x"
          ? rect?.right ?? window.innerWidth
          : rect?.bottom ?? window.innerHeight;
      const pos = axis === "x" ? e.clientX : e.clientY;
      setSize(Math.min(maxOf(rect), Math.max(min, far - pos)));
    },
    [axis, min, maxOf]
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    document.body.style.userSelect = "";
  }, []);

  return {
    size,
    ref,
    handleProps: { onPointerDown, onPointerMove, onPointerUp, className },
  };
}

const maxPanelWidth = () => window.innerWidth * 0.6;

/** Drag-to-resize for a right-side panel: drag its left edge to set width.
 * Attach `ref` to the panel, spread `handleProps` on the handle strip. */
export function usePanelResize(initial = 384, min = 280) {
  const { size, ref, handleProps } = useDragSize(
    "x",
    initial,
    min,
    // Measure from the panel's own right edge so stacked panels resize right.
    maxPanelWidth,
    "absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none hover:bg-zinc-300 active:bg-zinc-300"
  );
  return { width: size, ref, handleProps };
}

/** Drag-to-resize for a vertical split: drag the divider to set the bottom
 * section's height. Attach `ref` to the container holding both sections. */
export function useSplitResize(initial = 240, min = 120) {
  const maxOf = useCallback(
    (rect: DOMRect | undefined) => (rect ? rect.height - min : Infinity),
    [min]
  );
  const { size, ref, handleProps } = useDragSize<HTMLDivElement>(
    "y",
    initial,
    min,
    maxOf,
    "shrink-0 h-1.5 cursor-row-resize touch-none hover:bg-zinc-300 active:bg-zinc-300"
  );
  return { height: size, ref, handleProps };
}
