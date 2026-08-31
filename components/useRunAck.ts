"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  dependenciesOf,
  isTicketWaiting,
  satisfiesDependents,
  Ticket,
} from "@/lib/types";

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

/** Running a ticket's subgraph from outside it, given the same feedback as the
 * toolbar's play once you've navigated in: the beat of Running on the ticket
 * itself, and the nudge on the tickets inside this run can only park on again
 * (waiting on their human), waiting for him to come in and see it. */
export function ackSubgraphRun(path: string[], ticket: Ticket): void {
  const g = ticket.subgraph;
  const inner = [...path, ticket.id];
  ackTickets([
    ackKey(path, ticket.id),
    ...g.tickets
      .filter((t) =>
        isTicketWaiting(t, dependenciesOf(g, t.id).every(satisfiesDependents)),
      )
      .map((t) => ackKey(inner, t.id)),
  ]);
}

export function useTicketAck(key: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => ticketAcks.has(key),
    () => false,
  );
}
