"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Acknowledge a run click: report "running" for a beat so a ticket that
 * settles straight back to Waiting still visibly reacts to the press. Purely
 * presentational — the derived state takes over when the window expires. */
export function useRunAck(ms = 500): [boolean, () => void] {
  const [acking, setAcking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const ack = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setAcking(true);
    timer.current = setTimeout(() => setAcking(false), ms);
  }, [ms]);

  return [acking, ack];
}
