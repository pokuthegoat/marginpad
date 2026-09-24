import type Lenis from "lenis";
import type { LenisOptions } from "lenis";

/**
 * Smooth (inertial) mouse-wheel scrolling: the settings, and the one entry point other code uses to scroll the page
 * smoothly. The Lenis instance itself lives in src/components/SmoothScroll.tsx (mounted once, in the root layout).
 *
 * HOW THE WHEEL FEELS. Every wheel notch moves a target position by `wheelMultiplier` x its delta, and the page
 * glides from where it is to that target over a fixed WHEEL_DURATION, on an exponential ease-out: fast at first,
 * then a long soft landing. A new notch mid-glide restarts the glide toward the new, further target, so spinning the
 * wheel builds speed and stopping it leaves a coast. The scroll-linked background (SceneBackground.tsx) reads the
 * page's scroll position every frame, so it moves with exactly this glide.
 */
export const WHEEL_DURATION = 1.2;
const expoOut = (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t));

/** True for elements that scroll (or lock scrolling) by themselves: modals must keep native wheel behaviour. */
const isDialog = (node: HTMLElement) =>
  node.id === "privy-dialog" || // Privy's wallet dialog (a HeadlessUI dialog we don't control the markup of)
  node.getAttribute("role") === "dialog" ||
  node.getAttribute("aria-modal") === "true";

export const LENIS_OPTIONS: LenisOptions = {
  // No always-on animation loop: src/components/SmoothScroll.tsx runs frames only while the page is actually gliding.
  autoRaf: false,
  smoothWheel: true,
  duration: WHEEL_DURATION,
  easing: expoOut,
  wheelMultiplier: 1,
  // Touch and trackpad-free devices keep their own native, OS-tuned momentum. Only the mouse wheel is smoothed.
  syncTouch: false,
  // Clicking a link to another page during a glide cancels the glide, so the new page isn't scrolled by the old one.
  stopInertiaOnNavigate: true,
  respectReducedMotion: true,
  // Wheel events inside these are left alone (dialogs, or anything marked data-lenis-prevent, e.g. our username modal).
  prevent: isDialog,
};

// ---- Programmatic scrolling (anchor links) ---------------------------------------------------------------------

/** What SmoothScroll registers while Lenis is running, so callers can scroll without importing React or Lenis. */
interface Driver {
  lenis: Lenis;
  /** Starts running frames (they stop again by themselves once the page has settled). */
  wake: () => void;
}
let driver: Driver | null = null;

export function setSmoothScrollDriver(next: Driver | null) {
  driver = next;
}

export const isSmoothScrollActive = () => driver !== null;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Longer trips take a little longer, within reason: 0.8 s for a short hop up to 1.6 s for a long one. */
const anchorSeconds = (distance: number) => Math.min(1.6, 0.8 + distance / 5000);

/**
 * Scroll the page to `top` (px from the top of the document) with an eased glide.
 * Returns false when smooth scrolling isn't active (the visitor prefers reduced motion, or it hasn't mounted yet):
 * the caller then does a normal instant `window.scrollTo`.
 */
export function smoothScrollTo(top: number): boolean {
  if (!driver) return false;
  const { lenis, wake } = driver;
  lenis.scrollTo(top, { duration: anchorSeconds(Math.abs(top - lenis.scroll)), easing: easeInOutCubic });
  wake();
  return true;
}

/**
 * Glide to the element with this id (used by in-page links like #how). Falls back to an instant jump when smooth
 * scrolling isn't active. Returns false when the element isn't on the page, so the caller can leave the link alone.
 */
export function scrollToSection(id: string, offset = 24): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  const top = Math.max(0, el.getBoundingClientRect().top + window.scrollY - offset);
  if (!smoothScrollTo(top)) window.scrollTo({ top, behavior: "auto" });
  return true;
}
