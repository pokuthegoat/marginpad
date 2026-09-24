/**
 * The background's scroll choreography: a keyframed timeline from 0 to 1, driven by how far the page has been
 * scrolled (see `scrollToTimeline`). Each track animates one property of one scene node; between two keyframes the
 * value follows a cubic-bezier curve (linear unless the keyframe says otherwise), and outside a track's first/last
 * keyframe it holds that value.
 */

export type Ease = [number, number, number, number];
const LINEAR: Ease = [0, 0, 1, 1];
export const IN_OUT: Ease = [0.42, 0, 0.58, 1];

/** [position, value, ease-to-next] */
export type Key = [number, number, Ease?];
export type Vec = [number, number, number];

/** Transform tracks per node: any of position / rotation / scale, each as three per-axis key lists. */
export type NodeTracks = Partial<Record<"position" | "rotation" | "scale", [Key[], Key[], Key[]]>>;

const k3 = (keys: [number, Vec][], ease?: Ease): [Key[], Key[], Key[]] =>
  [0, 1, 2].map((axis) => keys.map(([t, v]) => [t, v[axis], ease] as Key)) as [Key[], Key[], Key[]];

export const TRACKS: Record<string, NodeTracks> = {
  light: {
    position: k3([
      [0, [2.4, 9.5, 9.5]],
      [0.1, [0.538, -0.051, 12.886]],
    ]),
  },
  // The whole page is one timeline (0 at the top, 1 at the bottom), with moments pinned to the landing sections by
  // data-scene-anchor in App.tsx. Each shape gets a few entrances and exits, so something is always arriving or
  // leaving:
  //   hero          coil on the right
  //   idea, how     coil drifts away top left, fan rises from below right
  //   pool          fan crosses the middle and opens up
  //   growth        fan exits left as the coil returns from the top right and uncoils
  //   sides         ribbon rises across the bottom
  //   risk          fan returns from the left and its bands draw together
  //   final         coil, fan and ribbon settle into a balanced frame around the closing card
  coil: {
    position: k3([
      [0, [1.2, -0.15, -0.3]],
      [0.08, [0.9, 0.4, 0]],
      [0.16, [-0.6, 1.5, 0.2]],
      [0.26, [-4.2, 3.6, -0.5]],
      [0.36, [4.6, 3.4, -1.0]],
      [0.5, [2.2, 1.0, -0.8]],
      [0.68, [2.0, 0.2, -0.6]],
      [0.9, [2.6, 1.2, -1.6]],
    ]),
    rotation: k3([
      [0, [0.6, 0.35, 0.4]],
      [0.08, [0.6, 0.45, 0.5]],
      [0.16, [0.7, 0.5, 0.7]],
      [0.26, [0.6, 0.7, 0.8]],
      [0.36, [0.7, -0.6, -0.6]],
      [0.5, [0.55, -0.4, -0.4]],
      [0.68, [0.5, -0.2, -0.2]],
      [0.9, [0.5, 0.1, 0.2]],
    ]),
    scale: k3([
      [0.68, [1, 1, 1]],
      [0.9, [0.8, 0.8, 0.8]],
    ]),
  },
  fan: {
    position: k3([
      [0.06, [2.9, -3.3, -2.2]],
      [0.18, [1.6, -1.2, -1.6]],
      [0.32, [-0.4, 0, -0.6]],
      [0.42, [-1.9, 0.3, -0.9]],
      [0.5, [-4.6, 0.6, -1.2]],
      [0.66, [-4.2, -1.0, -1.4]],
      [0.78, [-2.3, -0.2, -1.0]],
      [0.9, [-1.9, 0, -1.0]],
    ]),
    rotation: k3([
      [0.06, [0.3, -0.5, 0.2]],
      [0.18, [0.35, -0.4, 0.3]],
      [0.32, [0.3, -0.2, 0.4]],
      [0.42, [0.25, -0.1, 0.45]],
      [0.5, [0.2, 0, 0.5]],
      [0.66, [0.3, 0.5, -0.3]],
      [0.78, [0.3, 0.4, -0.2]],
      [0.9, [0.25, 0.3, -0.1]],
    ]),
  },
  sweep: {
    position: k3([
      [0.5, [0.8, -3.8, -1.5]],
      [0.66, [0.2, -1.5, -0.6]],
      [0.8, [0, -1.1, -0.2]],
      [0.92, [-0.2, -1.3, -0.5]],
    ]),
    rotation: k3([
      [0.5, [0.2, 0, 0.15]],
      [0.66, [0.15, 0, 0.05]],
      [0.8, [0.1, 0, 0]],
      [0.92, [0.1, 0.05, -0.05]],
    ]),
  },
};

/** Scalar tracks for materials. */
export const BACKDROP_ROUGHNESS: Key[] = [
  [0, 0.554],
  [0.099, 0.906],
];

function bezierY([x1, y1, x2, y2]: Ease, x: number): number {
  if (x1 === y1 && x2 === y2) return x;
  // Solve bezier x(u) = x by Newton, then return y(u).
  const bx = (u: number) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const dbx = (u: number) => 3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
  let u = x;
  for (let i = 0; i < 8; i++) {
    const d = dbx(u);
    if (Math.abs(d) < 1e-6) break;
    u = Math.min(1, Math.max(0, u - (bx(u) - x) / d));
  }
  return 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
}

export function sample(keys: Key[], t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0, ease = LINEAR] = keys[i - 1];
      return v0 + (v1 - v0) * bezierY(ease, (t - t0) / (t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

/**
 * Where on the timeline the page is. Anchors pin timeline positions to points in the document; the viewport's
 * bottom edge is what gets compared against them, and between two anchors the position is linear. Before the first
 * anchor it runs from 0 (bottom edge at one viewport height, i.e. the top of the page); after the last it runs to 1 at
 * the end of the document.
 */
export function scrollToTimeline(
  scrollY: number,
  viewportH: number,
  docH: number,
  anchors: { y: number; t: number }[],
): number {
  const bottom = scrollY + viewportH;
  let from = { y: viewportH, t: 0 };
  let to = { y: docH, t: 1 };
  for (const a of anchors.filter((a) => a.y > viewportH).sort((a, b) => a.y - b.y)) {
    if (a.y <= bottom) from = a;
    else {
      to = a;
      break;
    }
  }
  if (to.y === from.y) return from.t;
  return from.t + ((bottom - from.y) / (to.y - from.y)) * (to.t - from.t);
}
