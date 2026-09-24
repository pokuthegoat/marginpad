
import "lenis/dist/lenis.css";
import { ReactLenis, useLenis } from "lenis/react";
import { useEffect, useSyncExternalStore } from "react";
import { LENIS_OPTIONS, isSmoothScrollActive, setSmoothScrollDriver } from "../lib/smooth-scroll";

/**
 * The site's one smooth-scroll system (Lenis, in its recommended React form: <ReactLenis root />), mounted once in
 * the root layout so it covers every page. It draws nothing and wraps nothing: it only drives the window's scroll.
 * Settings and their rationale: src/lib/smooth-scroll.ts.
 *
 * REDUCED MOTION. With `prefers-reduced-motion: reduce` Lenis is not created at all, so wheel, keyboard and
 * anchor scrolling are the browser's own, instant and untouched. The preference is followed live (turn it on or
 * off while the page is open and smooth scrolling is removed or added without a reload).
 */

const REDUCED = "(prefers-reduced-motion: reduce)";
const subscribe = (onChange: () => void) => {
  const query = window.matchMedia(REDUCED);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const reducedNow = () => window.matchMedia(REDUCED).matches;
// The server (and hydration) can't know the preference, so start from "reduced" = no smooth scrolling.
const reducedOnServer = () => true;

export default function SmoothScroll() {
  const reduced = useSyncExternalStore(subscribe, reducedNow, reducedOnServer);
  if (reduced) return null;
  return (
    <>
      <ReactLenis root options={LENIS_OPTIONS} />
      <OnDemandFrames />
    </>
  );
}

/** Used for the very first wake-up, before a real frame interval has been measured (60 Hz). */
const DEFAULT_FRAME_MS = 1000 / 60;

/**
 * Runs Lenis's per-frame update ONLY while the page is gliding, instead of on every frame forever.
 *
 *  - A wheel event wakes the loop (Lenis announces each one as "virtual-scroll").
 *  - Each frame calls lenis.raf(); the loop keeps going while Lenis reports it is smooth-scrolling and stops the
 *    moment the glide has settled. At rest there is no timer, listener work or animation frame at all.
 *  - Lenis measures each step from the previous frame's timestamp. After a sleep that gap is huge and the first step
 *    would jump straight to the target, so on wake the clock is reset to one frame ago. "One frame" is the interval
 *    measured during the last glide, so the first step matches the rest on 60, 144 or 240 Hz screens alike.
 *
 * Touch, keyboard and scrollbar scrolling stay native and never wake it (Lenis just follows the browser's position).
 */
function OnDemandFrames() {
  const lenis = useLenis();

  useEffect(() => {
    if (!lenis) return;

    let frameId = 0;
    let fresh = false;
    let lastNow = 0; // 0 = no previous frame in this glide
    let frameMs = DEFAULT_FRAME_MS;

    const frame = (now: number) => {
      frameId = 0;
      if (fresh) {
        lenis.time = now - frameMs;
        fresh = false;
      } else if (lastNow) {
        frameMs = Math.min(34, Math.max(4, now - lastNow)); // ignore hitches and clock oddities
      }
      lastNow = now;
      lenis.raf(now);
      if (lenis.isScrolling === "smooth") frameId = requestAnimationFrame(frame);
      else lastNow = 0;
    };
    const wake = () => {
      if (frameId) return; // already running
      fresh = true;
      frameId = requestAnimationFrame(frame);
    };

    const stopListening = lenis.on("virtual-scroll", ({ event }) => {
      if (event.type === "wheel") wake();
    });
    setSmoothScrollDriver({ lenis, wake });

    return () => {
      stopListening();
      setSmoothScrollDriver(null);
      cancelAnimationFrame(frameId);
      // Lenis arms a 400 ms timer on every native scroll and doesn't clear it when destroyed, so tearing it down right
      // after a scroll makes it put its class back on <html> once more. Sweep that up (unless a new instance took over).
      window.setTimeout(() => {
        if (isSmoothScrollActive()) return;
        const root = document.documentElement;
        for (const name of [...root.classList]) if (name === "lenis" || name.startsWith("lenis-")) root.classList.remove(name);
      }, 500);
    };
  }, [lenis]);

  return null;
}
