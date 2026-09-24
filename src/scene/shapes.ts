import {
  ExtrudeGeometry,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Shape,
  Vector3,
  type BufferGeometry,
  type Material,
} from "three";

/**
 * The background's glass shapes, drawn from a spiral of curved, stepped slats: a helical coil of slats, a fan of
 * concentric arcs stacked in depth, and a long ribbon of tiles. Each is one InstancedMesh with `update(t)`, which
 * lays every instance out for timeline position t (see timeline.ts), so the shapes only ever move while the page
 * scrolls. They all use the scene's one glass material.
 */

export type Shape3D = {
  object: InstancedMesh;
  /** Lay the instances out for timeline position t (0 to 1). */
  update: (t: number) => void;
};

const TAU = Math.PI * 2;
/** Smooth 0 to 1 ramp of x between a and b (holds at both ends). */
const ramp = (x: number, a: number, b: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

const extrude = (s: Shape, thickness: number, bevel: number): ExtrudeGeometry =>
  new ExtrudeGeometry(s, {
    depth: thickness - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 8,
    curveSegments: 24,
  });

/**
 * A thin glass plate with rounded corners and a fully rounded rim, centred on the origin. It spans X (width) and Y
 * (height); its faces point along ±Z.
 */
export function plateGeometry(width: number, height: number, thickness: number, corner: number): ExtrudeGeometry {
  const bevel = thickness * 0.49;
  const w = width / 2 - bevel, h = height / 2 - bevel, r = Math.min(corner, w, h);
  const s = new Shape();
  const q = Math.PI / 2;
  s.moveTo(-w + r, -h);
  s.lineTo(w - r, -h);
  s.absarc(w - r, -h + r, r, -q, 0, false);
  s.lineTo(w, h - r);
  s.absarc(w - r, h - r, r, 0, q, false);
  s.lineTo(-w + r, h);
  s.absarc(-w + r, h - r, r, q, 2 * q, false);
  s.lineTo(-w, -h + r);
  s.absarc(-w + r, -h + r, r, 2 * q, 3 * q, false);
  const geo = extrude(s, thickness, bevel);
  geo.center();
  return geo;
}

/**
 * A curved slat: a slice of a ring (an annular sector) with the same fully rounded glass rim. The ring's centre is
 * the origin, the slat is centred on the +X axis, spans `span` radians, and lies in the XY plane with its faces
 * along ±Z. Only its thickness is centred, so the origin stays the ring's centre.
 */
export function arcGeometry(radius: number, width: number, span: number, thickness: number): BufferGeometry {
  const bevel = thickness * 0.49;
  const ro = radius + width / 2 - bevel, ri = radius - width / 2 + bevel;
  const a = span / 2 - bevel / radius;
  const s = new Shape();
  s.absarc(0, 0, ro, -a, a, false);
  s.absarc(0, 0, ri, a, -a, true);
  s.closePath();
  const geo = extrude(s, thickness, bevel);
  geo.translate(0, 0, -(thickness - bevel * 2) / 2);
  return geo;
}

const m4 = new Matrix4();
const qa = new Quaternion();
const qb = new Quaternion();
const pos = new Vector3();
const scl = new Vector3();

function finish(mesh: InstancedMesh) {
  // Instances move every frame, so the geometry's own bounds are no use for culling.
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * The coil: curved slats stepped up a helix like a spiral staircase, big at the bottom and shrinking to a funnel
 * at the top. The axis is local Y.
 *  - Scrolling turns the whole coil on its axis.
 *  - The steps open out as you scroll, so the spiral uncoils (a little on the way out, and again when it returns).
 *  - A ripple of tilt runs up through the slats.
 */
export function createCoil(material: Material): Shape3D {
  const N = 28;
  const geo = arcGeometry(1.7, 0.52, 1.15, 0.05);
  geo.rotateX(-Math.PI / 2); // lay the slat flat: it now lies in the XZ plane with its faces along ±Y
  const mesh = finish(new InstancedMesh(geo, material, N));
  const update = (t: number) => {
    const spin = t * TAU * 1.2;
    const rise = 0.11 + 0.03 * ramp(t, 0, 0.3) + 0.05 * ramp(t, 0.38, 0.68);
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const s = 1 - 0.58 * Math.pow(u, 0.85);
      const phi = i * 0.62 + spin;
      const tilt = 0.16 * Math.sin(t * TAU * 3 - i * 0.4);
      qa.setFromAxisAngle(Y, phi);
      qb.setFromAxisAngle(Z, tilt);
      qa.multiply(qb);
      pos.set(0, (i - (N - 1) / 2) * rise, 0);
      mesh.setMatrixAt(i, m4.compose(pos, qa, scl.setScalar(s)));
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0);
  return { object: mesh, update };
}

/**
 * The fan: concentric arc bands stacked in depth, each stepped a little round from the last, like the inside of a
 * vortex. It faces the camera (the axis is local Z).
 *  - Scrolling turns each band at a slightly different speed, like the rings of a combination lock.
 *  - The layers spread apart in depth as it crosses, then the bands draw together and close up near the end.
 */
export function createFan(material: Material): Shape3D {
  const N = 15;
  const geo = arcGeometry(1, 0.3, 2.1, 0.05);
  const mesh = finish(new InstancedMesh(geo, material, N));
  const update = (t: number) => {
    const spin = -t * TAU * 1.4;
    const gap = 0.05 + 0.1 * ramp(t, 0, 0.35) - 0.07 * ramp(t, 0.68, 0.82);
    const close = ramp(t, 0.68, 0.82);
    for (let j = 0; j < N; j++) {
      const s = 0.45 + j * 0.105;
      const alpha = j * 0.34 * (1 - 0.55 * close) + spin * (1 + 0.09 * j);
      qa.setFromAxisAngle(Z, alpha);
      qb.setFromAxisAngle(X, 0.12 * Math.sin(t * TAU * 2 + j * 0.5));
      qa.multiply(qb);
      pos.set(0, 0, -j * gap);
      mesh.setMatrixAt(j, m4.compose(pos, qa, scl.setScalar(s)));
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0);
  return { object: mesh, update };
}

/**
 * The sweep: a long, gently bowed ribbon of thin glass tiles, each turned to follow the curve.
 *  - Scrolling sends a wave down its length: every tile rolls about the ribbon's direction a little after the last.
 */
export function createSweep(material: Material): Shape3D {
  const N = 15;
  const geo = plateGeometry(0.6, 0.42, 0.04, 0.1);
  const mesh = finish(new InstancedMesh(geo, material, N));
  const path = (u: number, out: Vector3) =>
    out.set((u - 0.5) * 6.2, 0.36 * Math.sin(u * Math.PI * 1.4 + 0.3), -0.5 * Math.sin(u * Math.PI));
  const p = new Vector3(), ahead = new Vector3(), behind = new Vector3();
  const tangent = new Vector3(), face = new Vector3(), up = new Vector3();
  const update = (t: number) => {
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      path(u, p);
      tangent.copy(path(Math.min(1, u + 0.01), ahead)).sub(path(Math.max(0, u - 0.01), behind)).normalize();
      face.crossVectors(tangent, Y).normalize(); // the tile's face: perpendicular to the path, roughly toward the camera
      up.crossVectors(face, tangent);
      m4.makeBasis(tangent, up, face);
      qa.setFromRotationMatrix(m4);
      qb.setFromAxisAngle(X, 0.35 * Math.sin(t * TAU * 2.5 - i * 0.7));
      qa.multiply(qb);
      mesh.setMatrixAt(i, m4.compose(p, qa, scl.set(1, 1, 1)));
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0);
  return { object: mesh, update };
}
