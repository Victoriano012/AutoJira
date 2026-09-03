"use client";

import { useEffect, type RefObject } from "react";
import { useStore } from "@/lib/store";

/**
 * Two-finger swipes (wheel events) move between views. Horizontal (dominant
 * deltaX) goes back: from the chat to the board, from the board to the
 * projects. Vertical goes between the board and the chat: fingers travelling
 * up pull the chat up, travelling down send it back down. Native
 * capture-phase, non-passive listener so it can preventDefault (which kills
 * the browser's own history swipe) for the horizontal axis.
 *
 * Mounted once, at page level, on the element holding the open project's view.
 */

/**
 * One gesture, one navigation — module scope, not a per-instance ref: a dev
 * refresh of this module re-creates the hook instance under the person's
 * still-moving fingers, and a lock living in it would be brand new there, so
 * the rest of the same inertia tail would navigate a second time — one flick,
 * two layers.
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

/** A vertical scroller between the event target and the listener that can
 * still move the way the fingers push owns the gesture. At its end (or with
 * nothing to scroll) the same swipe is a request to change view. */
function scrollsVertically(from: EventTarget | null, until: HTMLElement, dy: number): boolean {
  let el = from instanceof Element ? from : null;
  while (el && el !== until) {
    if (el.scrollHeight > el.clientHeight + 1) {
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === "auto" || overflow === "scroll") {
        const room = dy > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop;
        if (room > 1) return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

/** The vertical gesture's own clock and lock (same shape and reasons as
 * `gesture`). `scrolling`: this burst started by scrolling a list, so the
 * rest of it — including the inertia that runs past the list's end — is
 * scrolling too, not a view change. */
const vertical = { acc: 0, locked: false, scrolling: false, last: -Infinity, dir: 0 };

function onVerticalWheel(e: WheelEvent, el: HTMLElement): void {
  const target = e.target;
  if (!(target instanceof Node) || !el.contains(target)) return;
  if (e.timeStamp - vertical.last > 150) {
    vertical.acc = 0;
    vertical.locked = false;
    vertical.scrolling = false;
  }
  // Fingers back on the pad, pushing the other way, is a new gesture even
  // while the last one's momentum is still arriving (momentum never changes
  // sign). Otherwise an up-then-down has to wait the momentum out — or be
  // stopped with a tap — before the down counts.
  if (vertical.locked && Math.sign(e.deltaY) === -vertical.dir) {
    vertical.acc = 0;
    vertical.locked = false;
    vertical.scrolling = false;
  }
  vertical.last = e.timeStamp;
  if (vertical.scrolling) return;
  if (vertical.locked) {
    // The tail of a swipe that already switched: keep it off whatever list
    // now sits under the fingers.
    e.preventDefault();
    return;
  }
  if (scrollsVertically(target, el, e.deltaY)) {
    vertical.scrolling = true;
    return;
  }
  e.preventDefault();
  vertical.acc += e.deltaY;
  if (Math.abs(vertical.acc) > 80) {
    // Positive deltaY is fingers moving up under the default (natural)
    // scroll direction: the motion of pulling the sheet up from the bottom.
    const up = vertical.acc > 0;
    vertical.locked = true;
    vertical.dir = up ? 1 : -1;
    vertical.acc = 0;
    const st = useStore.getState();
    if (up && st.mode === "panel") st.setMode("act");
    else if (!up && st.mode === "act") st.setMode("panel");
  }
}

export function useSwipeNav(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.ctrlKey) return; // pinch zoom stays as is
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) {
        onVerticalWheel(e, el);
        return;
      }
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
        // The same exits the toolbar takes, so the fold-into-the-node animation
        // runs for a swipe too.
        if (st.mode === "act") st.setMode("panel");
        else st.closeProject();
      }
    };
    // On the document, not on the view element: the view is covered mid-flight
    // and the events have to still be seen. Capture-phase and non-passive all
    // the same, so the browser's history swipe stays out of it.
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => document.removeEventListener("wheel", onWheel, { capture: true });
  }, [ref]);
}
