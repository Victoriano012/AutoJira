"use client";

import { useCallback, useRef, useState } from "react";

/** Drag-to-resize for a right-side panel: drag its left edge to set width.
 * Attach `ref` to the panel, spread `handleProps` on the handle strip. */
export function usePanelResize(initial = 384, min = 280) {
  const [width, setWidth] = useState(initial);
  const ref = useRef<HTMLElement>(null);
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
      // Measure from the panel's own right edge so stacked panels resize right.
      const right = ref.current?.getBoundingClientRect().right ?? window.innerWidth;
      const max = window.innerWidth * 0.6;
      setWidth(Math.min(max, Math.max(min, right - e.clientX)));
    },
    [min]
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    document.body.style.userSelect = "";
  }, []);

  return {
    width,
    ref,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      className:
        "absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none hover:bg-zinc-300 active:bg-zinc-300",
    },
  };
}
