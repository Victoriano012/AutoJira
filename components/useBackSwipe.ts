"use client";

import { useEffect, type RefObject } from "react";
import { useStore } from "@/lib/store";

/**
 * Two-finger horizontal swipe (wheel events with dominant deltaX) navigates
 * back one layer instead of zooming/panning. Native capture-phase, non-passive
 * listener so it can preventDefault (which kills the browser's own history
 * swipe) and stop React Flow's wheel handling for the horizontal axis.
 *
 * Attach it to the view's outermost element — a graph canvas or a human-review
 * board, whichever of the two is mounted. Never both at once: `app/page.tsx`
 * renders one or the other.
 */

/**
 * One gesture, one navigation — module scope, not a per-instance ref: the
 * navigation swaps the view out from under the person's still-moving fingers,
 * so the listener that saw the start of the burst unmounts and a fresh one on
 * the view that just arrived sees the rest of the same inertia tail. A lock
 * living in the hook instance would be brand new there, and that tail would
 * navigate a second time — one flick, two layers.
 */
const gesture = { acc: 0, locked: false, last: -Infinity };

/** A real horizontal scroller between the event target and the listener owns
 * the gesture: the person means to scroll it, not to leave the view. */
function scrollsHorizontally(from: EventTarget | null, until: HTMLElement): boolean {
  let el = from instanceof Element ? from : null;
  while (el && el !== until) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflow = getComputedStyle(el).overflowX;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
    el = el.parentElement;
  }
  return false;
}

export function useBackSwipe(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.ctrlKey) return; // pinch zoom stays as is
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical scroll stays as is
      const target = e.target;
      // The navigation this gesture just caused puts a click shield over the
      // view for the flight (see `lib/view-zoom.ts`), so the rest of the burst
      // lands on that instead. Swallow it there and keep the gesture clock
      // running — otherwise the tail arrives after the shield lifts looking
      // like a fresh flick, and one swipe walks back two layers.
      if (target instanceof Element && target.classList.contains("zoom-shield")) {
        e.preventDefault();
        gesture.last = e.timeStamp;
        return;
      }
      if (!(target instanceof Node) || !el.contains(target)) return;
      if (scrollsHorizontally(target, el)) return;
      e.preventDefault();
      e.stopPropagation();
      // A ≥150ms gap since the previous horizontal event marks a new gesture.
      // Deciding at event time (not with a trailing quiet timer) matters: a
      // locked-out swipe must not push the release further into the future,
      // or quick successive swipes chain-extend the lock indefinitely.
      if (e.timeStamp - gesture.last > 150) {
        gesture.acc = 0;
        gesture.locked = false;
      }
      gesture.last = e.timeStamp;
      if (gesture.locked) return; // inertia tail of a swipe that already navigated
      gesture.acc += e.deltaX;
      // The sign of deltaX for a physical right-swipe flips with the user's
      // scroll-direction setting, so a strong horizontal accumulation in
      // either direction means "go back" — one gesture, one action.
      if (Math.abs(gesture.acc) > 80) {
        gesture.locked = true;
        gesture.acc = 0;
        const st = useStore.getState();
        // The same exits the toolbar's back button takes, so the fold-into-the-
        // card animation runs for a swipe too.
        if (st.path.length > 0) st.setPath(st.path.slice(0, -1));
        else st.closeProject();
      }
    };
    // On the document, not on the view element: the view is covered mid-flight
    // and the events have to still be seen. Capture-phase and non-passive all
    // the same, so React Flow's own wheel handling never gets the horizontal
    // axis and the browser's history swipe stays out of it.
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => document.removeEventListener("wheel", onWheel, { capture: true });
  }, [ref]);
}
