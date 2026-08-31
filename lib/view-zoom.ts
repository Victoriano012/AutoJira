"use client";

/**
 * Drilling into a card, and back out, as one continuous motion.
 *
 * What travels is a *card-shaped box* — a rounded rect with the ticket's own
 * status colour and an opaque fill — not the view itself. Going in it grows
 * from the card to the frame the view will fill; going out it collapses from
 * the frame back onto the card. The real view is only ever swapped underneath
 * it, while the box covers the frame.
 *
 * That is deliberate, and it is the whole point. The first attempt scaled the
 * incoming view with a CSS transform, which broke React Flow: it derives edge
 * paths from handle positions read via `getBoundingClientRect`, so a canvas
 * mounted inside `scale(0.18)` computes every arrow from ~18%-sized handles
 * and keeps those paths after the transform is gone — the arrows stay visibly
 * detached until something else forces a re-measure. Here the canvas never
 * mounts under a transform, so its geometry is right the first time. It also
 * reads as it should: you see a card grow, not magnified text.
 *
 * The box is a plain DOM node on `document.body`, not a React element, because
 * it has to outlive the tree it starts in — opening a project unmounts the
 * whole project picker mid-flight.
 */

type Dir = "in" | "out";
type Rect = { left: number; top: number; width: number; height: number };
type Card = {
  rect: Rect;
  color: string;
  /** True if the details panel was open when this was measured, so the graph
   * behind will re-fit wider on the way back and the rect is only a guess. */
  narrow: boolean;
};

/** Going in: grow, then hold (the new view mounts and fits behind an opaque
 * box), then fade the box off it. Going out there is nothing to hide, so no
 * hold, and it can be a touch quicker — you already know where you are going. */
const GROW_IN_MS = 330;
const GROW_OUT_MS = 240;
const HOLD_MS = 60;
const FADE_MS = 120;
const CARD_RADIUS = 12; // rounded-xl, as on a ticket card
const FRAME_RADIUS = 8; // rounded-lg, as on the view frame
/** Fallback when there is no card to travel to or from (a reload, then Back):
 * a nominal card in the middle of the frame, in neutral zinc-300. */
const CARD_W = 264;
const CARD_H = 92;
const NEUTRAL = "#d4d4d8";

type State = {
  /** Where each level's card was, so going back out can return to it. */
  cards: Map<string, Card>;
  box: HTMLDivElement | null;
  shield: HTMLDivElement | null;
  timers: number[];
  rafs: number[];
  /** A commit still owed by a flight in progress (going in defers it). */
  commit: (() => void) | null;
  /** The entry points the window-singleton store calls — see the bottom. */
  api?: { path: typeof runPath; close: typeof runClose };
};

// On `window`, for the reason the store is: `next dev` re-evaluates this module
// constantly, and the mounted caller and the fresh import must be talking about
// the same box and the same recorded rects.
const win =
  typeof window === "undefined"
    ? null
    : (window as unknown as { __autojiraViewZoom2?: State });
const S: State =
  win?.__autojiraViewZoom2 ?? {
    cards: new Map(),
    box: null,
    shield: null,
    timers: [],
    rafs: [],
    commit: null,
  };
if (win) win.__autojiraViewZoom2 = S;

function ensure(): { box: HTMLDivElement; shield: HTMLDivElement } {
  if (!S.box || !S.box.isConnected) {
    const box = document.createElement("div");
    box.className = "zoom-box";
    box.setAttribute("aria-hidden", "true");
    // Swallows clicks for the flight: going in, the path is committed late, so
    // a click landing meanwhile would act on the view being left behind.
    const shield = document.createElement("div");
    shield.className = "zoom-shield";
    shield.setAttribute("aria-hidden", "true");
    document.body.append(shield, box);
    S.box = box;
    S.shield = shield;
  }
  return { box: S.box, shield: S.shield! };
}

/** Ends the flight in progress, paying any commit it still owes. */
function stop(): void {
  for (const t of S.timers) clearTimeout(t);
  for (const r of S.rafs) cancelAnimationFrame(r);
  S.timers = [];
  S.rafs = [];
  const owed = S.commit;
  S.commit = null;
  if (S.box) {
    S.box.style.transition = "none";
    S.box.style.display = "none";
    S.box.style.opacity = "1";
  }
  if (S.shield) S.shield.style.display = "none";
  owed?.();
}

/** Forces a style/layout recalc, so the geometry just written becomes the value
 * the next change transitions *from*. */
function flush(box: HTMLDivElement): void {
  void box.offsetWidth;
}

function place(box: HTMLDivElement, r: Rect, radius: number): void {
  box.style.left = `${r.left}px`;
  box.style.top = `${r.top}px`;
  box.style.width = `${r.width}px`;
  box.style.height = `${r.height}px`;
  box.style.borderRadius = `${radius}px`;
}

/** The element the view lives in: `main` in a project, the canvas container in
 * the project picker (same geometry — both sit under a 4rem header). */
function viewHost(): HTMLElement | null {
  return (
    document.querySelector("main") ??
    (document.querySelector(".react-flow")?.parentElement as HTMLElement | null) ??
    null
  );
}

/** The clipped box a view at `depth` fills — the nested outline frames in
 * `app/page.tsx` inset it by 3 + 4 per level. */
function frameRect(depth: number, panelClosing: boolean): Rect | null {
  const host = viewHost();
  if (!host) return null;
  const r = host.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  // Navigating clears the selection, so the details panel is about to close and
  // `main` about to widen. Land on the box the view will occupy, not the
  // narrower one it is in now — otherwise the box stops ~400px short.
  let right = r.right;
  if (panelClosing && host.tagName === "MAIN" && host.parentElement) {
    right = host.parentElement.getBoundingClientRect().right;
  }
  const pad = 3 + 4 * depth;
  return {
    left: r.left + pad,
    top: r.top + pad,
    width: right - r.left - 2 * pad,
    height: r.height - 2 * pad,
  };
}

/** A node's card: where it is, and the status colour of its border. */
function cardOf(id: string, narrow = false): Card | null {
  const node = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  const el = (node?.firstElementChild ?? node) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return {
    rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    color: getComputedStyle(el).borderTopColor || NEUTRAL,
    narrow,
  };
}

/** How the canvas is currently panned/zoomed. A canvas that has just mounted
 * has not run `fitView` yet, so its nodes are not where they will be — this
 * holding still for a frame is the signal that they are. */
const viewportKey = () =>
  (document.querySelector(".react-flow__viewport") as HTMLElement | null)?.style.transform ?? "";

type Flight = {
  key: string;
  dir: Dir;
  /** Node to grow out of, or (going out) to look for in the destination. */
  cardId: string | null;
  /** Depth of the frame the box starts at (in) or ends at (out). */
  depth: number;
  panelClosing: boolean;
  commit: () => void;
};

/** Runs one flight. Resolves once `commit` has been paid — which, going in, is
 * when the box has covered the frame. */
function fly(o: Flight): Promise<void> {
  stop();
  if (
    typeof document === "undefined" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    o.commit();
    return Promise.resolve();
  }
  const frame = frameRect(o.depth, o.panelClosing);
  if (!frame) {
    o.commit();
    return Promise.resolve();
  }

  let card: Card | null;
  if (o.dir === "in") {
    card = o.cardId ? cardOf(o.cardId, o.panelClosing) : null;
    if (card) S.cards.set(o.key, card);
  } else {
    // The card belongs to a view that has not mounted yet, so the only rect
    // available up front is the one taken on the way in.
    card = S.cards.get(o.key) ?? null;
    S.cards.delete(o.key);
  }
  const small: Card =
    card ?? {
      color: NEUTRAL,
      narrow: false,
      rect: {
        left: frame.left + Math.max(0, frame.width - CARD_W) / 2,
        top: frame.top + Math.max(0, frame.height - CARD_H) / 2,
        width: Math.min(CARD_W, frame.width),
        height: Math.min(CARD_H, frame.height),
      },
    };

  const { box, shield } = ensure();
  shield.style.display = "block";
  box.style.display = "block";
  box.style.opacity = "1";
  box.style.transition = "none";
  box.style.borderColor = small.color;

  const move = (ms: number, ease: string, fade = "") =>
    ["left", "top", "width", "height", "border-radius"]
      .map((p) => `${p} ${ms}ms ${ease}`)
      .concat(fade ? [fade] : [])
      .join(", ");

  if (o.dir === "in") {
    place(box, small.rect, CARD_RADIUS);
    // Make the start state the browser's current answer before asking for the
    // end one — a `requestAnimationFrame` is not enough, since rAF callbacks
    // run *before* style recalc, so both writes would land in one recalc and
    // the box would simply appear at the frame.
    flush(box);
    return new Promise((resolve) => {
      S.commit = () => {
        o.commit();
        resolve();
      };
      box.style.transition = move(GROW_IN_MS, "ease-out");
      place(box, frame, FRAME_RADIUS);
      // The box now covers the frame: swap the view under it, give it a beat to
      // mount and fit, then fade the box off it.
      S.timers.push(
        window.setTimeout(() => {
          const owed = S.commit;
          S.commit = null;
          owed?.();
        }, GROW_IN_MS)
      );
      S.timers.push(
        window.setTimeout(() => {
          box.style.transition = `opacity ${FADE_MS}ms ease-out`;
          box.style.opacity = "0";
        }, GROW_IN_MS + HOLD_MS)
      );
      S.timers.push(window.setTimeout(stop, GROW_IN_MS + HOLD_MS + FADE_MS + 40));
    });
  }

  // Going out: the destination is on screen from the first frame, behind an
  // opaque box that collapses onto the card being returned to.
  place(box, frame, FRAME_RADIUS);
  flush(box);
  o.commit();
  const collapseTo = (end: Card) => {
    box.style.borderColor = end.color;
    box.style.transition = move(
      GROW_OUT_MS,
      "ease-in",
      `opacity ${FADE_MS}ms ease-in ${GROW_OUT_MS - FADE_MS}ms`
    );
    place(box, end.rect, CARD_RADIUS);
    box.style.opacity = "0";
    S.timers.push(window.setTimeout(stop, GROW_OUT_MS + 40));
  };
  // The rect recorded on the way in is where the card will be again: the graph
  // behind re-mounts and re-fits into the same box, so start collapsing at once.
  // Unless it was recorded with the details panel open — that box was ~400px
  // narrower, so the graph fits differently and the card has to be found again
  // once the destination canvas has mounted and settled.
  if (card && !card.narrow) {
    collapseTo(card);
    return Promise.resolve();
  }
  let tries = 0;
  let seen = "";
  const settle = () => {
    const key = viewportKey();
    const found = o.cardId ? cardOf(o.cardId) : null;
    if (tries++ < 6 && (!found || key !== seen)) {
      seen = key;
      S.rafs.push(requestAnimationFrame(settle));
      return;
    }
    collapseTo(found ?? small);
  };
  S.rafs.push(requestAnimationFrame(settle));
  return Promise.resolve();
}

const isPrefix = (a: string[], b: string[]) =>
  a.length <= b.length && a.every((x, i) => x === b[i]);

const pathKey = (p: string[]) => `t:${p.join("/")}`;
const projectKey = (id: string) => `p:${id}`;

/**
 * Animate a `setPath`, and commit it at the right moment.
 *
 * Central here rather than at the ~9 call sites because this is the one moment
 * the card being travelled through is still on screen to be measured — and it
 * covers every entry point (node, details panel, breadcrumb, back, swipe, the
 * board's "All good").
 */
function runPath(
  from: string[],
  to: string[],
  panelOpen: boolean,
  commit: () => void
): void {
  let run = () => {
    stop();
    commit();
  };
  if (isPrefix(from, to) && to.length > from.length) {
    const card = to[from.length];
    const key = pathKey(to.slice(0, from.length + 1));
    run = () =>
      void fly({ key, dir: "in", cardId: card, depth: to.length, panelClosing: panelOpen, commit });
  } else if (isPrefix(to, from) && to.length < from.length) {
    const key = pathKey(from.slice(0, to.length + 1));
    run = () =>
      void fly({
        key,
        dir: "out",
        cardId: from[to.length],
        depth: from.length,
        panelClosing: panelOpen,
        commit,
      });
  }
  run();
  // Only cards on the way down to `to` can still be returned to.
  for (const key of S.cards.keys()) {
    if (key.startsWith("t:") && !isPrefix(key.slice(2).split("/"), to)) S.cards.delete(key);
  }
}

/**
 * Opening a project from the meta-graph: the project node grows into the whole
 * project view. The fetch behind it starts at once and is not waited on — the
 * returned promise resolves when the box has landed, so the caller can hold the
 * *state* swap until then and let "Loading project…" sit behind the box if the
 * fetch is the slower of the two.
 */
export function zoomIntoProject(id: string): Promise<void> {
  return fly({
    key: projectKey(id),
    dir: "in",
    cardId: id,
    depth: 0,
    panelClosing: false,
    commit: () => {},
  });
}

/** Closing a project: the view folds back into its node on the meta-graph. */
function runClose(
  id: string | null,
  depth: number,
  panelOpen: boolean,
  commit: () => void
): void {
  if (!id) {
    stop();
    commit();
    return;
  }
  void fly({
    key: projectKey(id),
    dir: "out",
    cardId: id,
    depth,
    panelClosing: panelOpen,
    commit,
  });
}

// The store is a window singleton (see the note in `lib/store.ts`) whose
// `setPath`/`closeProject` close over *this module's* exports. A `next dev`
// re-evaluation replaces the module but not the store, so those closures would
// go on calling the previous copy — which looks exactly like "the animation
// stopped working, but only for tickets", the project picker having been
// re-rendered with a fresh import. So the two entry points the store owns are
// resolved through `window` as well, and the code that runs is the code on disk.
S.api = { path: runPath, close: runClose };
export const zoomPath: typeof runPath = (...a) => (S.api?.path ?? runPath)(...a);
export const zoomOutOfProject: typeof runClose = (...a) => (S.api?.close ?? runClose)(...a);
