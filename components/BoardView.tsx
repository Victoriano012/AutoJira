"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { layoutGraph } from "@/lib/layout";
import {
  approveTicket,
  rejectTicket,
  runGraph,
  runTicket,
  stopTicket,
} from "@/lib/runner";
import { useStore } from "@/lib/store";
import ChatInput from "./ChatInput";
import { HandIcon, Spinner, StopSquare } from "./icons";
import {
  BoardColumn,
  boardColumn,
  contextChain,
  dependenciesOf,
  GraphEdge,
  graphAtPath,
  fileBlockees,
  fileClaims,
  isTicketDone,
  newTicket,
  satisfiesDependentsOnBoard,
  Ticket,
  ticketAtPath,
  TicketStatus,
} from "@/lib/types";

type ColumnId = BoardColumn;

const COLUMNS: {
  id: ColumnId;
  title: string;
  tint: string;
  header: string;
}[] = [
  {
    id: "blocked",
    title: "Blocked",
    tint: "border-zinc-200 bg-zinc-100/70",
    header: "text-zinc-500",
  },
  {
    id: "working",
    title: "Working",
    tint: "border-blue-200 bg-blue-50",
    header: "text-blue-600",
  },
  {
    id: "review",
    title: "Ready for review",
    tint: "border-yellow-200 bg-yellow-50",
    header: "text-yellow-700",
  },
  {
    id: "done",
    title: "Done",
    tint: "border-emerald-200 bg-emerald-50",
    header: "text-emerald-700",
  },
];

interface GeneratedTicket {
  title: string;
  description: string;
  files: string[];
  dependsOn: number[];
  dependsOnExisting: number[];
}

interface PendingRequest {
  id: string;
  text: string;
  error?: string;
}

/** 2 lines of text-xs (16px line-height) + py-1 (8px) + 2px border. */
const REJECT_MAX_HEIGHT = 42;

/** Sent to the agent when a card is rejected with nothing typed. */
const DEFAULT_REJECTION =
  "This isn't finished. Go back over the work, find what is missing or wrong, and complete it properly.";

/** Unsent request text, per board, kept outside React so a remount can't eat
 * it. sessionStorage: it belongs to this tab, and nothing here needs a server. */
const DRAFT_KEY = "autojira-board-draft:";
function readDraft(pathKey: string) {
  try {
    return sessionStorage.getItem(DRAFT_KEY + pathKey) ?? "";
  } catch {
    return "";
  }
}
function writeDraft(pathKey: string, value: string) {
  try {
    if (value) sessionStorage.setItem(DRAFT_KEY + pathKey, value);
    else sessionStorage.removeItem(DRAFT_KEY + pathKey);
  } catch {
    // Private mode or a blocked store: the draft just isn't durable.
  }
}

/** Requests that have been sent but not turned into tickets yet, per board. */
const REQUESTS_KEY = "autojira-board-requests:";
function readRequests(pathKey: string): PendingRequest[] {
  try {
    const raw = sessionStorage.getItem(REQUESTS_KEY + pathKey);
    const rows = raw ? (JSON.parse(raw) as PendingRequest[]) : [];
    // The fetch that would have answered these died with the render that
    // started it, so nothing is coming: a restored request is the person's
    // words back in their hands — retry it or take it back into the box — and
    // never a spinner that cannot stop.
    return rows.map((r) => ({
      ...r,
      error: r.error ?? "the page reloaded before the answer came back",
    }));
  } catch {
    return [];
  }
}
function writeRequests(pathKey: string, rows: PendingRequest[]) {
  try {
    if (rows.length) {
      sessionStorage.setItem(REQUESTS_KEY + pathKey, JSON.stringify(rows));
    } else {
      sessionStorage.removeItem(REQUESTS_KEY + pathKey);
    }
  } catch {
    // Private mode or a blocked store: nothing to do but keep going.
  }
}

interface DepLine {
  id: string;
  d: string; // svg path
  unmet: boolean; // target still waits on this dependency
}

/** Jira-like kanban view over a human ticket's subgraph. The columns are a
 * pure function of ordinary ticket statuses, so the existing runner drives
 * every card move. */
export default function BoardView() {
  const project = useStore((s) => s.project);
  const path = useStore((s) => s.path);
  const { updateGraph, updateTicket } = useStore.getState();

  // Card selection is local to the board: it only expands the card's
  // description. Routing it through the store's selection would also open the
  // canvas's side details panel, which has no place in board view.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pathKey = path.join("/");
  useEffect(() => setSelectedId(null), [pathKey]);

  const graph = graphAtPath(project.graph, path);

  // ---- grow-in for cards that have just turned up ----
  // The board seeds itself with whatever it opens with, so nothing animates on
  // load or when a project opens; only an id it has never drawn grows in. The
  // id stops being new once the animation is over, because a column move
  // remounts the card and would otherwise replay it.
  const seenIds = useRef(new Set<string>());
  const seededFor = useRef<string | null>(null);
  const enteringIds = useRef(new Set<string>());
  if (graph) {
    if (seededFor.current !== pathKey) {
      // First render of this board (or of another one): seed, don't animate.
      seededFor.current = pathKey;
      seenIds.current = new Set(graph.tickets.map((t) => t.id));
    } else {
      for (const t of graph.tickets) {
        if (seenIds.current.has(t.id)) continue;
        seenIds.current.add(t.id);
        enteringIds.current.add(t.id);
        setTimeout(() => enteringIds.current.delete(t.id), 400);
      }
    }
  }

  // ---- bottom-bar change requests (one Claude conversation per board) ----
  // Sent, not answered yet. Stored like the draft, and for the same reason: a
  // remount must not swallow a request somebody is waiting on — silently
  // dropping it is what "it was processing and then it just disappeared" is.
  const [requests, setRequestsState] = useState<PendingRequest[]>(() =>
    readRequests(pathKey)
  );
  const setRequests = (fn: (r: PendingRequest[]) => PendingRequest[]) =>
    setRequestsState((r) => {
      const next = fn(r);
      writeRequests(pathKey, next);
      return next;
    });
  // Per board, like the draft.
  useEffect(() => setRequestsState(readRequests(pathKey)), [pathKey]);
  // The draft outlives the input, per board: a remount — a reload, a dev-server
  // restart, navigating away and back — must never eat what someone was
  // halfway through typing. It clears only when the request is actually sent.
  const [draft, setDraftState] = useState(() => readDraft(pathKey));
  const setDraft = (v: string) => {
    setDraftState(v);
    writeDraft(pathKey, v);
  };
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  // ---- Done column: follow new arrivals ----
  const doneListRef = useRef<HTMLDivElement>(null);
  const doneIds = useRef(new Set<string>());
  const doneSeeded = useRef(false);
  const doneAtBottom = useRef(true);

  function submitRequest() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const id = crypto.randomUUID();
    setRequests((r) => [...r, { id, text }]);
    // Requests share one conversation — run them one at a time so each
    // resumes the sessionId the previous one produced.
    chainRef.current = chainRef.current
      .then(() => processRequest(id, text))
      .catch(() => {});
  }

  /** Send a failed request again, unchanged — nothing was written. */
  function retryRequest(id: string) {
    const r = requests.find((x) => x.id === id);
    if (!r) return;
    setRequests((rs) => rs.map((x) => (x.id === id ? { ...x, error: undefined } : x)));
    chainRef.current = chainRef.current
      .then(() => processRequest(id, r.text))
      .catch(() => {});
  }

  /** Giving up on a failed request hands the typing back rather than losing it. */
  function dismissRequest(r: PendingRequest) {
    setRequests((rs) => rs.filter((x) => x.id !== r.id));
    setDraft(draft.trim() ? `${draft.trim()} ${r.text}` : r.text);
  }

  async function processRequest(id: string, text: string) {
    try {
      const st = useStore.getState();
      const g = graphAtPath(st.project.graph, path);
      const parent = ticketAtPath(st.project.graph, path.slice(0, -1), path[path.length - 1]);
      if (!g || !parent) return;
      const unsolved = g.tickets.filter((t) => !isTicketDone(t));

      const res = await fetch("/api/board-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request: text,
          sessionId: parent.boardSessionId,
          existing: unsolved.map((t) => ({
            title: t.title,
            description: t.description.slice(0, 400),
            status: t.status,
            files: t.files ?? [],
          })),
          chain: parent.boardSessionId
            ? undefined
            : contextChain(st.project, path).map(({ title, description }) => ({
                title,
                description,
              })),
        }),
      });
      const data = (await res.json()) as {
        tickets?: GeneratedTicket[];
        sessionId?: string;
        error?: string;
      };
      if (!res.ok || !data.tickets) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      // Board tickets are human reviews: the human's check/cross on the board
      // is the approval step, and dependents wait for it.
      const created = data.tickets.map((gt) =>
        newTicket({
          title: gt.title,
          description: gt.description,
          type: "human_review",
          // Declared, never inferred: the board serialises cards that name the
          // same file so two agents never edit it at once.
          files: gt.files ?? [],
        })
      );
      const edges: GraphEdge[] = [];
      data.tickets.forEach((gt, i) => {
        for (const d of gt.dependsOn) {
          if (d >= 0 && d < i) {
            edges.push({ id: crypto.randomUUID(), source: created[d].id, target: created[i].id });
          }
        }
        for (const e of gt.dependsOnExisting) {
          if (unsolved[e]) {
            edges.push({ id: crypto.randomUUID(), source: unsolved[e].id, target: created[i].id });
          }
        }
      });

      if (data.sessionId) {
        updateTicket(path.slice(0, -1), parent.id, (t) => ({
          ...t,
          boardSessionId: data.sessionId,
        }));
      }
      updateGraph(path, (cur) => {
        const known = new Set(cur.tickets.map((t) => t.id));
        for (const t of created) known.add(t.id);
        const merged = {
          tickets: [...cur.tickets, ...created],
          edges: [
            ...cur.edges,
            ...edges.filter((e) => known.has(e.source) && known.has(e.target)),
          ],
        };
        // Positions keep the same subgraph presentable on the normal canvas.
        const pos = layoutGraph(merged);
        return {
          ...merged,
          tickets: merged.tickets.map((t) =>
            t.position || !created.includes(t)
              ? t
              : { ...t, position: pos.get(t.id) ?? null }
          ),
        };
      });
      setRequests((r) => r.filter((x) => x.id !== id));
      void runGraph(path); // spawn agents for whatever just became ready
    } catch (err) {
      setRequests((r) =>
        r.map((x) =>
          x.id === id
            ? { ...x, error: String(err instanceof Error ? err.message : err) }
            : x
        )
      );
    }
  }

  // ---- reject flow (red cross on a review card) ----
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  // Drafts outlive the input: one per ticket, dropped only when the person
  // empties the box themselves or the rejection is actually sent.
  const [rejectDrafts, setRejectDrafts] = useState<Record<string, string>>({});
  const rejectBoxRef = useRef<HTMLDivElement>(null);
  const rejectInputRef = useRef<HTMLTextAreaElement>(null);
  const rejectDraft = rejectingId ? (rejectDrafts[rejectingId] ?? "") : "";
  /** The ✓ and ✕ the server has not answered yet: ticket id → the status the
   * person's answer will give it, the status it had when they gave it, and
   * when. Both answers are the person's own decision, so the card leaves review
   * on the click and the round-trip only confirms it. */
  const [pending, setPending] = useState<
    Record<string, { becomes: TicketStatus; was: TicketStatus; at: number }>
  >({});
  const hold = (t: Ticket, becomes: TicketStatus) =>
    setPending((p) => ({ ...p, [t.id]: { becomes, was: t.status, at: Date.now() } }));

  // A hold lasts exactly until the truth arrives — the card's status moves off
  // the one it was answered in — and no longer than a few seconds regardless,
  // so an answer that never reaches the server leaves the card where the
  // server really has it rather than pinned in the wrong column.
  useEffect(() => {
    const ids = Object.keys(pending);
    if (ids.length === 0) return;
    const drop = (stale: string[]) => {
      if (stale.length === 0) return;
      setPending((p) => {
        const next = { ...p };
        for (const id of stale) delete next[id];
        return next;
      });
    };
    drop(
      ids.filter((id) => {
        const t = graph?.tickets.find((x) => x.id === id);
        return !t || t.status !== pending[id].was;
      })
    );
    const timer = setTimeout(
      () => drop(ids.filter((id) => Date.now() - pending[id].at > 10_000)),
      10_000
    );
    return () => clearTimeout(timer);
  }, [pending, graph]);

  // Grows with the text up to two lines, then scrolls — same as ChatInput.
  // Reopening on another ticket re-runs it, so a restored multi-line draft
  // comes back at the height it had.
  useEffect(() => {
    const el = rejectInputRef.current;
    if (!el) return;
    el.style.height = "auto"; // shrink so scrollHeight reflects the content
    const h = Math.min(el.scrollHeight + 2, REJECT_MAX_HEIGHT);
    el.style.height = `${h}px`;
    el.style.overflowY = h >= REJECT_MAX_HEIGHT ? "auto" : "hidden";
  }, [rejectingId, rejectDraft]);

  // Anything pressed outside the open input dismisses it, draft intact.
  useEffect(() => {
    if (!rejectingId) return;
    const onDown = (e: PointerEvent) => {
      if (!rejectBoxRef.current?.contains(e.target as Node)) setRejectingId(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [rejectingId]);

  /** Stop the agent and keep the ticket out of the queue until the person
   * starts it again. The flag is the browser's own field, so it outlives the
   * reload the server's stop does not know about. */
  const stopping = useRef(new Set<string>());
  function pause(ticketId: string) {
    stopTicket(path, ticketId);
    // The agent takes a moment to wind down: until its status leaves "running"
    // the ticket is stopping, not started again.
    stopping.current.add(ticketId);
    updateTicket(path, ticketId, (t) => ({ ...t, paused: true }));
  }

  // A pause only means anything while the ticket waits in the queue. Once it is
  // running again — the board's Run button, or a graph run, which deliberately
  // lifts stops — or the agent has carried it on to review, the pause is over.
  useEffect(() => {
    for (const t of graph?.tickets ?? []) {
      if (t.status !== "running") stopping.current.delete(t.id);
      if (t.paused && t.status !== "todo" && !stopping.current.has(t.id))
        updateTicket(path, t.id, (x) => ({ ...x, paused: false }));
    }
  });

  function resume(ticketId: string) {
    updateTicket(path, ticketId, (t) => ({ ...t, paused: false }));
    void runTicket(path, ticketId);
  }

  function submitReject(t: Ticket) {
    const msg = (rejectDrafts[t.id] ?? "").trim() || DEFAULT_REJECTION;
    setRejectingId(null);
    setRejectDrafts((d) => ({ ...d, [t.id]: "" }));
    // Back to its agent: Working, or Blocked if another card holds its file.
    hold(t, "todo");
    void rejectTicket(path, t.id, msg).catch(() =>
      // The rejection never reached the server: the card is still the person's.
      setPending((p) => {
        const next = { ...p };
        delete next[t.id];
        return next;
      })
    );
  }

  /** The ✓: the person has signed the card off, so it is Done from this click. */
  function submitApprove(t: Ticket) {
    hold(t, "done");
    approveTicket(path, t.id);
  }

  // ---- FLIP column-move animation + dependency lines ----
  const boardRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const skipFlipRef = useRef(false);
  const [, setMeasureTick] = useState(0);
  const [lines, setLines] = useState<DepLine[]>([]);
  const linesKeyRef = useRef("");

  useEffect(() => {
    const onResize = () => {
      skipFlipRef.current = true;
      setMeasureTick((t) => t + 1);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board || !graph) return;

    // FLIP: cards keyed by ticket id — a card that changed column is a new
    // DOM node, but the delta from its previous rect still animates it
    // continuously from where it was. The measured element is the wrapper and
    // the animation runs on the card inside it, so a rect read here is always
    // the card's settled position: measuring an animating element would report
    // where it came from, and this effect (which runs after every render, and
    // renders again whenever the lines move) would animate the opposite delta
    // and loop until React gave up with "Maximum update depth exceeded".
    const next = new Map<string, DOMRect>();
    for (const [id, el] of cardRefs.current) {
      if (el.isConnected) next.set(id, el.getBoundingClientRect());
    }
    if (!skipFlipRef.current) {
      for (const [id, rect] of next) {
        const old = prevRects.current.get(id);
        if (!old) continue;
        const dx = old.left - rect.left;
        const dy = old.top - rect.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          (cardRefs.current.get(id)!.firstElementChild as HTMLElement).animate(
            [
              { transform: `translate(${dx}px, ${dy}px)` },
              { transform: "translate(0, 0)" },
            ],
            { duration: 300, easing: "ease" }
          );
        }
      }
    }
    skipFlipRef.current = false;
    prevRects.current = next;

    // Dependency lines between cards, in board coordinates.
    const bRect = board.getBoundingClientRect();
    const newLines: DepLine[] = [];
    for (const e of graph.edges) {
      const s = next.get(e.source);
      const t = next.get(e.target);
      if (!s || !t) continue;
      const src = graph.tickets.find((x) => x.id === e.source);
      const y1 = s.top + s.height / 2 - bRect.top;
      const y2 = t.top + t.height / 2 - bRect.top;
      let d: string;
      if (s.right + 12 < t.left || t.right + 12 < s.left) {
        const forward = s.right + 12 < t.left;
        const x1 = (forward ? s.right : s.left) - bRect.left;
        const x2 = (forward ? t.left : t.right) - bRect.left;
        const off = Math.min(Math.max(Math.abs(x2 - x1) / 2, 24), 80);
        const c1 = x1 + (x2 >= x1 ? off : -off);
        const c2 = x2 + (x2 >= x1 ? -off : off);
        d = `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`;
      } else {
        // Same column: both anchors would sit on the same edges, so a plain
        // curve folds flat across the cards. Keep the cross-column
        // convention — out of the source's right edge, into the target's left
        // edge pointing right — and route the link around the stack instead:
        // down the gutter, back across through the free gap beside the target.
        const x1 = s.right - bRect.left;
        const x2 = t.left - bRect.left;
        const xr = x1 + 13; // middle of the gutter on either side of the column
        const xl = x2 - 13;
        // The 8px gap next to the target, on the side the link arrives from,
        // is the one horizontal band that never has a card in it.
        const yc = y2 > y1 ? t.top - bRect.top - 4 : t.top + t.height - bRect.top + 4;
        const r = Math.min(10, Math.abs(yc - y1) / 2, Math.abs(y2 - yc) / 2);
        const s1 = Math.sign(yc - y1) * r;
        const s2 = Math.sign(y2 - yc) * r;
        d =
          `M ${x1} ${y1} L ${xr - r} ${y1} Q ${xr} ${y1}, ${xr} ${y1 + s1}` +
          ` L ${xr} ${yc - s1} Q ${xr} ${yc}, ${xr - r} ${yc}` +
          ` L ${xl + r} ${yc} Q ${xl} ${yc}, ${xl} ${yc + s2}` +
          ` L ${xl} ${y2 - s2} Q ${xl} ${y2}, ${xl + r} ${y2} L ${x2} ${y2}`;
      }
      newLines.push({
        id: e.id,
        d,
        unmet: !!src && !satisfiesDependentsOnBoard(src),
      });
    }
    const key = newLines.map((l) => `${l.id}${l.d}${l.unmet}`).join("|");
    if (key !== linesKeyRef.current) {
      linesKeyRef.current = key;
      setLines(newLines);
    }
  });

  if (!graph) return null;

  // The graph area draws one nested frame per layer (inset 3 + i*4 px, see
  // app/page.tsx); sit essentially flush inside the innermost frame so the
  // column stack uses the space right up to the border.
  const frameInset = 3 + path.length * 4 + 2;

  const isReady = (t: Ticket) =>
    dependenciesOf(graph, t.id).every(satisfiesDependentsOnBoard);
  const unmetTitles = (t: Ticket) =>
    dependenciesOf(graph, t.id)
      .filter((d) => !satisfiesDependentsOnBoard(d))
      .map((d) => d.title)
      .join(", ") || "waiting on dependencies";

  // File contention, straight off the helpers so the board says exactly what
  // the scheduler does: who waits on a file, and who is holding one.
  const claimsOf = (t: Ticket) => fileClaims(graph, t.id, true);
  const blockeesOf = (t: Ticket) => fileBlockees(graph, t.id, true);

  const byColumn = new Map<ColumnId, Ticket[]>(COLUMNS.map((c) => [c.id, []]));
  for (const t of graph.tickets) {
    // A card whose ✓ or ✕ is still on its way to the server is placed as the
    // status it is about to have, so it leaves review on the click rather than
    // a round-trip later.
    const p = pending[t.id];
    const asked = p ? { ...t, status: p.becomes } : t;
    byColumn.get(boardColumn(graph, asked, true))!.push(t);
  }
  // The four columns are the whole board: every card is in exactly one of them,
  // so a card that renders nowhere is a bug and not a state to discover from a
  // person telling you their tickets disappeared.
  if (process.env.NODE_ENV !== "production") {
    const placed = COLUMNS.reduce((n, c) => n + byColumn.get(c.id)!.length, 0);
    if (placed !== graph.tickets.length)
      console.error(
        `BoardView: ${graph.tickets.length} cards, ${placed} placed in columns`
      );
  }
  const doneKey = byColumn
    .get("done")!
    .map((t) => t.id)
    .join(",");

  // A card landing in Done scrolls the column down to it — but only if the
  // person was already at the bottom, so scrolling up to read something older
  // is never yanked away. `doneAtBottom` tracks their last scroll, not the
  // current geometry, which drifts as the column grows.
  useEffect(() => {
    const ids = doneKey ? doneKey.split(",") : [];
    const arrived =
      doneSeeded.current && ids.some((id) => !doneIds.current.has(id));
    doneIds.current = new Set(ids);
    doneSeeded.current = true;
    const el = doneListRef.current;
    if (!el) return;
    if (arrived && doneAtBottom.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      return;
    }
    // Nothing arrived, so this geometry is the person's own position — the
    // reading the next arrival is judged against. (Once a card lands, the
    // column has already grown and it is too late to ask.)
    doneAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  }, [doneKey]);

  const cardRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  };

  // The board's own ticket — the human-review ticket this window belongs to.
  const parentPath = path.slice(0, -1);
  const parent = ticketAtPath(project.graph, parentPath, path[path.length - 1]);

  return (
    // Cards stop this click, so anything else — column background, headers,
    // the footer button, the request bar — lands here and clears the selection
    // while still doing whatever it does itself.
    <div className="flex h-full w-full flex-col" onClick={() => setSelectedId(null)}>
      {/* columns */}
      <div
        ref={boardRef}
        className="relative flex min-h-0 flex-1 gap-2"
        style={{ padding: frameInset }}
        onScrollCapture={() => {
          skipFlipRef.current = true;
          setMeasureTick((t) => t + 1);
        }}
      >
        {COLUMNS.map((col) => (
          <div
            key={col.id}
            // min-w-0: without it a flex child never shrinks below its content,
            // so one long title would widen its column and squeeze the others.
            // The four columns are always a quarter of the board each.
            className={`flex min-h-0 w-0 min-w-0 flex-1 flex-col rounded-xl border ${col.tint}`}
          >
            <div
              className={`flex items-center justify-between px-3 pb-1 pt-2.5 text-xs font-semibold uppercase tracking-wide ${col.header}`}
            >
              <span>{col.title}</span>
              <span className="font-normal opacity-70">
                {byColumn.get(col.id)!.length}
              </span>
            </div>
            <div
              ref={col.id === "done" ? doneListRef : undefined}
              onScroll={
                col.id === "done"
                  ? (e) => {
                      const el = e.currentTarget;
                      doneAtBottom.current =
                        el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
                    }
                  : undefined
              }
              className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2"
            >
              {byColumn.get(col.id)!.map((t) => {
                // Files this card waits for, and files it holds that somebody
                // else waits for. Both lists sit in the card's bottom-left, with
                // the card's own control right-aligned on the last of them.
                const claims = claimsOf(t);
                // One line per ticket, not per file: three shared files are one
                // reason. Both cards name the same file; the rest are on hover.
                const heldLines = blockeesOf(t).map((b) => (
                  <div
                    key={b.who.id}
                    title={`${b.who.title} is waiting for ${b.files.join(", ")}`}
                    className="flex min-w-0 items-center gap-1 text-zinc-400"
                  >
                    <HandIcon />
                    <span className="truncate">{b.file}</span>
                    <span className="truncate opacity-80">{b.who.title}</span>
                  </div>
                ));
                return (
                // The wrapper is what the effect above measures; the card
                // inside it is what the FLIP animation moves.
                <div key={t.id} ref={cardRef(t.id)}>
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedId((id) => (id === t.id ? null : t.id));
                    }}
                    className={`cursor-pointer rounded-xl border bg-white p-3 shadow-sm hover:shadow ${
                      enteringIds.current.has(t.id) ? "ticket-appear " : ""
                    }${
                      t.id === selectedId
                        ? "border-violet-500"
                        : t.status === "error"
                          ? "border-red-300"
                          : "border-zinc-200"
                    }`}
                  >
                    <div className="line-clamp-2 break-words text-sm font-medium text-zinc-900">
                      {t.title}
                    </div>
                    {/* Description only on the pressed card — capped at ~6 lines
                     * (text-xs line-height is 1rem), the rest scrolls. */}
                    {t.id === selectedId && t.description && (
                      <div
                        // Reading and scrolling it is not a press on the card:
                        // dragging its scrollbar must not collapse it.
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1 max-h-24 overflow-y-auto overscroll-contain text-xs text-zinc-500"
                      >
                        {t.description}
                      </div>
                    )}

                    {col.id === "blocked" && (
                      // Every reason this card is not moving, stacked; the way
                      // back out (paused only) sits on the last of them.
                      <div className="mt-2 flex items-end justify-between gap-2 text-[11px]">
                        <div className="min-w-0 space-y-0.5 text-zinc-400">
                          {t.paused && (
                            <div>{t.status === "running" ? "Stopping…" : "Paused"}</div>
                          )}
                          {!isReady(t) && (
                            <div className="truncate" title={unmetTitles(t)}>
                              ⛔ {unmetTitles(t)}
                            </div>
                          )}
                          {claims.map((c) => (
                            <div
                              key={c.by.id}
                              title={`Waiting for ${c.files.join(", ")}, held by ${c.by.title}`}
                              className="flex min-w-0 items-center gap-1"
                            >
                              <span className="truncate">⛔ {c.file}</span>
                              <span className="truncate opacity-80">{c.by.title}</span>
                            </div>
                          ))}
                          {heldLines}
                        </div>
                        {t.paused && (
                          <button
                            disabled={!isReady(t) || t.status === "running"}
                            title={
                              t.status === "running"
                                ? "Stopping the agent…"
                                : isReady(t)
                                  ? "Run"
                                  : "Waiting on dependencies"
                            }
                            className={`shrink-0 text-sm leading-none ${
                              isReady(t) && t.status !== "running"
                                ? "text-emerald-600 hover:text-emerald-500"
                                : "cursor-not-allowed text-zinc-400"
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              resume(t.id);
                            }}
                          >
                            ▶
                          </button>
                        )}
                      </div>
                    )}

                    {col.id === "working" && (
                      // The spinner alone says the agent is on it; stop sits
                      // beside it, on the right where the eye already is.
                      <div className="mt-2 flex items-end justify-between gap-2 text-[11px]">
                        <div className="min-w-0 space-y-0.5">
                          {t.status === "error" ? (
                            <div className="text-red-500">Failed</div>
                          ) : t.status === "running" ? null : (
                            <div className="text-blue-500/80">Queued</div>
                          )}
                          {heldLines}
                        </div>
                        {t.status === "running" ? (
                          <div
                            className="flex shrink-0 items-center gap-2"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <StopSquare onClick={() => pause(t.id)} />
                            <Spinner className="h-2.5 w-2.5" />
                          </div>
                        ) : t.status === "error" ? (
                          <button
                            className="shrink-0 rounded-md bg-zinc-100 px-2 py-0.5 text-zinc-700 hover:bg-zinc-200"
                            onClick={(e) => {
                              e.stopPropagation();
                              void runTicket(path, t.id);
                            }}
                          >
                            ↻ Retry
                          </button>
                        ) : null}
                      </div>
                    )}

                    {col.id === "review" && (
                      <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                        {rejectingId === t.id ? (
                          <div ref={rejectBoxRef} className="flex items-center gap-1.5">
                            <textarea
                              autoFocus
                              ref={rejectInputRef}
                              rows={1}
                              className="block min-w-0 flex-1 resize-none rounded-md border border-red-300 bg-white px-2 py-1 text-xs outline-none focus:border-red-400"
                              placeholder="What's wrong?"
                              value={rejectDrafts[t.id] ?? ""}
                              onChange={(e) =>
                                setRejectDrafts((d) => ({ ...d, [t.id]: e.target.value }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  submitReject(t);
                                }
                                if (e.key === "Escape") setRejectingId(null);
                              }}
                            />
                            <button
                              className="rounded-md bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-400"
                              onClick={() => submitReject(t)}
                            >
                              Send
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <button
                              className="flex-1 rounded-md bg-emerald-100 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-200"
                              title="Approve — mark done"
                              onClick={() => submitApprove(t)}
                            >
                              ✓
                            </button>
                            <button
                              className="flex-1 rounded-md bg-red-100 py-1 text-xs font-medium text-red-600 hover:bg-red-200"
                              title="Reject — describe what's wrong"
                              onClick={() => setRejectingId(t.id)}
                            >
                              ✕
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                );
              })}
            </div>

            {/* pinned column footer — resolve/reopen this human-review ticket */}
            {col.id === "done" && parent && (
              <div className="shrink-0 px-2 pb-2">
                {parent.status !== "done" ? (
                  <button
                    className="w-full rounded-md border border-emerald-600 bg-emerald-600 px-1 py-px text-lg font-bold leading-tight text-white hover:border-emerald-500 hover:bg-emerald-500"
                    title="Mark this human-review ticket complete — no issues remaining"
                    // Not a plain status write: a run parked on this human gate
                    // resumes only through approveTicket.
                    onClick={() => approveTicket(parentPath, parent.id)}
                  >
                    All good
                  </button>
                ) : (
                  <button
                    className="w-full cursor-pointer rounded-full border border-zinc-300 bg-white px-1 py-px text-lg font-bold leading-tight text-zinc-600 shadow-sm transition-colors hover:border-violet-400 hover:text-violet-600"
                    title="Reopen this human-review ticket"
                    onClick={() =>
                      updateTicket(parentPath, parent.id, (t) => ({
                        ...t,
                        status: "todo",
                      }))
                    }
                  >
                    Reopen
                  </button>
                )}
              </div>
            )}
          </div>
        ))}

        {/* dependency links, drawn over the columns */}
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <defs>
            <marker
              id="board-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#a1a1aa" />
            </marker>
          </defs>
          {lines.map((l) => (
            <path
              key={l.id}
              d={l.d}
              fill="none"
              stroke={l.unmet ? "#a1a1aa" : "#d4d4d8"}
              strokeWidth={1.5}
              strokeOpacity={l.unmet ? 0.7 : 0.45}
              markerEnd="url(#board-arrow)"
            />
          ))}
        </svg>

      </div>

      {/* processing chips */}
      {requests.length > 0 && (
        <div
          className="space-y-1.5 pb-2"
          style={{ marginLeft: frameInset, marginRight: frameInset }}
        >
          {requests.map((r) =>
            r.error ? (
              <div
                key={r.id}
                className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700"
              >
                <span className="min-w-0 flex-1 truncate">
                  {r.text} — {r.error}
                </span>
                <button
                  className="shrink-0 rounded-md bg-red-100 px-2 py-0.5 text-red-700 hover:bg-red-200"
                  onClick={() => retryRequest(r.id)}
                >
                  ↻ Retry
                </button>
                <button
                  title="Dismiss and put the text back in the box"
                  className="shrink-0 text-red-400 hover:text-red-600"
                  onClick={() => dismissRequest(r)}
                >
                  ✕
                </button>
              </div>
            ) : (
              <div
                key={r.id}
                className="flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-800"
              >
                <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-violet-300 border-t-violet-700" />
                <span className="min-w-0 flex-1 truncate">{r.text}</span>
                <span className="shrink-0 text-violet-500/70">
                  breaking into tickets…
                </span>
              </div>
            )
          )}
        </div>
      )}

      {/* bottom bar */}
      <div
        className="flex shrink-0 items-center gap-2"
        style={{ margin: `0 ${frameInset}px ${frameInset}px` }}
      >
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSend={submitRequest}
          placeholder="What should be changed? AI will turn it into tickets and get to work"
          sendTitle="Send — AI will turn it into tickets"
        />
      </div>
    </div>
  );
}
