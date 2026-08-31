"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

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

/** The same window, but per ticket and driven from outside the node: a graph
 * run that only lands on tickets already waiting on a human changes nothing
 * they render from, so the tickets it swept show the Running presentation for
 * a beat before settling back. Module-level state with subscribe/notify (the
 * shape the runner uses for its run subscription) because the marking happens
 * in the toolbar, not in the node. */
const ticketAcks = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const notify = () => {
  for (const fn of listeners) fn();
};

export const ackKey = (path: string[], ticketId: string) =>
  path.join("/") + "#" + ticketId;

export function ackTickets(keys: string[], ms = 500): void {
  if (keys.length === 0) return;
  for (const key of keys) {
    clearTimeout(ticketAcks.get(key));
    ticketAcks.set(
      key,
      setTimeout(() => {
        ticketAcks.delete(key);
        notify();
      }, ms),
    );
  }
  notify();
}

export function useTicketAck(key: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => ticketAcks.has(key),
    () => false,
  );
}
