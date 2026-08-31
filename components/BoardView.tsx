"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { layoutGraph } from "@/lib/layout";
import { approveTicket, rejectTicket, runGraph, runTicket } from "@/lib/runner";
import { useStore } from "@/lib/store";
import ChatInput from "./ChatInput";
import {
  contextChain,
  dependenciesOf,
  GraphEdge,
  graphAtPath,
  isTicketDone,
  newTicket,
  satisfiesDependents,
  Ticket,
  ticketAtPath,
} from "@/lib/types";

type ColumnId = "blocked" | "working" | "review" | "done";

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

function columnOf(t: Ticket, ready: boolean): ColumnId {
  if (isTicketDone(t)) return "done";
  if (t.status === "review") return "review";
  if (t.status === "running" || t.status === "error") return "working";
  return ready ? "working" : "blocked"; // todo
}

interface GeneratedTicket {
  title: string;
  description: string;
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

  // ---- bottom-bar change requests (one Claude conversation per board) ----
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [draft, setDraft] = useState("");
  const chainRef = useRef<Promise<void>>(Promise.resolve());

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

      // Board tickets are non-blocking human reviews: the agent's finish
      // ("review") already satisfies dependents, and the human's check/cross
      // on the board is the approval step.
      const created = data.tickets.map((gt) =>
        newTicket({
          title: gt.title,
          description: gt.description,
          type: "human_review",
          blocking: false,
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

  function submitReject(ticketId: string) {
    const msg = (rejectDrafts[ticketId] ?? "").trim() || DEFAULT_REJECTION;
    setRejectingId(null);
    setRejectDrafts((d) => ({ ...d, [ticketId]: "" }));
    void rejectTicket(path, ticketId, msg);
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
        unmet: !!src && !satisfiesDependents(src),
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

  const byColumn = new Map<ColumnId, Ticket[]>(COLUMNS.map((c) => [c.id, []]));
  for (const t of graph.tickets) {
    const ready = dependenciesOf(graph, t.id).every(satisfiesDependents);
    byColumn.get(columnOf(t, ready))!.push(t);
  }

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
            className={`flex min-h-0 flex-1 flex-col rounded-xl border ${col.tint}`}
          >
            <div
              className={`flex items-center justify-between px-3 pb-1 pt-2.5 text-xs font-semibold uppercase tracking-wide ${col.header}`}
            >
              <span>{col.title}</span>
              <span className="font-normal opacity-70">
                {byColumn.get(col.id)!.length}
              </span>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
              {byColumn.get(col.id)!.map((t) => (
                // The wrapper is what the effect above measures; the card
                // inside it is what the FLIP animation moves.
                <div key={t.id} ref={cardRef(t.id)}>
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedId((id) => (id === t.id ? null : t.id));
                    }}
                    className={`cursor-pointer rounded-xl border bg-white p-3 shadow-sm hover:shadow ${
                      t.id === selectedId
                        ? "border-violet-500"
                        : t.status === "error"
                          ? "border-red-300"
                          : "border-zinc-200"
                    }`}
                  >
                    <div className="line-clamp-2 text-sm font-medium text-zinc-900">
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
                      <div className="mt-2 text-[11px] text-zinc-400">
                        ⛔{" "}
                        {dependenciesOf(graph, t.id)
                          .filter((d) => !satisfiesDependents(d))
                          .map((d) => d.title)
                          .join(", ") || "waiting on dependencies"}
                      </div>
                    )}

                    {col.id === "working" &&
                      (t.status === "running" ? (
                        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-blue-600">
                          <span className="h-2.5 w-2.5 animate-spin rounded-full border border-blue-400 border-t-transparent" />
                          Agent working…
                        </div>
                      ) : t.status === "error" ? (
                        <div className="mt-2 flex items-center gap-2 text-[11px]">
                          <span className="text-red-500">Failed</span>
                          <button
                            className="rounded-md bg-zinc-100 px-2 py-0.5 text-zinc-700 hover:bg-zinc-200"
                            onClick={(e) => {
                              e.stopPropagation();
                              void runTicket(path, t.id);
                            }}
                          >
                            ↻ Retry
                          </button>
                        </div>
                      ) : (
                        <div className="mt-2 text-[11px] text-blue-500/80">
                          Queued
                        </div>
                      ))}

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
                                  submitReject(t.id);
                                }
                                if (e.key === "Escape") setRejectingId(null);
                              }}
                            />
                            <button
                              className="rounded-md bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-400"
                              onClick={() => submitReject(t.id)}
                            >
                              Send
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <button
                              className="flex-1 rounded-md bg-emerald-100 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-200"
                              title="Approve — mark done"
                              onClick={() => approveTicket(path, t.id)}
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
              ))}
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
                  className="shrink-0 text-red-400 hover:text-red-600"
                  onClick={() =>
                    setRequests((rs) => rs.filter((x) => x.id !== r.id))
                  }
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
