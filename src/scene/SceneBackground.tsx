
import { useEffect, useRef } from "react";
import * as THREE from "three";
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from "postprocessing";
import { BeamsEffect } from "./beams";
import { GrainEffect } from "./grain";
import { createCoil, createFan, createSweep } from "./shapes";
import { BACKDROP_ROUGHNESS, TRACKS, sample, scrollToTimeline, type NodeTracks, type Vec } from "./timeline";

/**
 * The site's background: a coil, a fan and a ribbon of curved glass slats in deep navy. Scrolling the landing page plays a keyframed
 * timeline (src/lib/scene/timeline.ts): the light swings round, each shape turns, unfurls or ripples the whole way down, and
 * the shapes hand over to one another (the coil drifts off top left as the fan rises, the ribbon comes up from
 * below at the end), so the picture never stands still while the page moves. The mouse has no effect on it.
 *
 * Behind the wheels: soft light beams slanting across the backdrop (src/lib/scene/beams.ts), sliding sideways with
 * the scroll only.
 *
 * Timeline anchors: any element with `data-scene-anchor="<timeline position>"` pins that position to the moment the
 * element's top reaches the bottom of the viewport. Without anchors the timeline spans the whole page.
 *
 * `dim` (the app pages): one still frame, veiled by CSS, rendered only when the window is resized, so nothing
 * animates behind games and dense UI.
 */

const BG = "#020828";
const FOV = 20;
const MIN_HALF_WIDTH = 1.15;
/** The still frame used behind the app pages: the fan crossing to the left with the ribbon rising below, clear of the centred UI. */
const DIM_T = 0.3;

type Transform = { position?: Vec; rotation?: Vec; scale?: Vec | number };

function place(obj: THREE.Object3D, t: Transform) {
  if (t.position) obj.position.set(...t.position);
  if (t.rotation) obj.rotation.set(...t.rotation);
  if (t.scale !== undefined) typeof t.scale === "number" ? obj.scale.setScalar(t.scale) : obj.scale.set(...t.scale);
  return obj;
}

function applyTracks(obj: THREE.Object3D, tracks: NodeTracks, t: number) {
  for (const prop of ["position", "rotation", "scale"] as const) {
    const axes = tracks[prop];
    if (!axes) continue;
    obj[prop].set(sample(axes[0], t), sample(axes[1], t), sample(axes[2], t));
  }
}

function buildScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);

  // Tuned against reference frames, not taken from any spec sheet: with three r186's lighting, a physically "clean"
  // glass flares white wherever a plate faces the light. The plates should read as dark glass with soft blue edges, and
  // the frosted backdrop as a broad blue glow, so the plates get very little specular/clearcoat, a little sheen for the
  // rims, and the light is fairly strong (it mostly shows on the backdrop).
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.3868,
    metalness: 0,
    ior: 1.5,
    transmission: 1,
    thickness: 0.1,
    dispersion: 1,
    sheen: 0.1,
    sheenRoughness: 0.2509,
    sheenColor: new THREE.Color("#a5edee"),
    specularIntensity: 0.05,
    specularColor: new THREE.Color("#aad4f6"),
  });
  const backdropMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: BACKDROP_ROUGHNESS[0][1],
    metalness: 0,
    ior: 1.5,
    transmission: 1,
    thickness: 0,
  });

  // A strong royal blue. Its channels are given as linear values on purpose (#2450e6 read without the sRGB decode):
  // the decoded colour is a much deeper violet-blue, and the backdrop then glows purple instead of steel blue.
  const light = new THREE.DirectionalLight(0xffffff, 50);
  light.color.setRGB(0x24 / 255, 0x50 / 255, 0xe6 / 255, THREE.LinearSRGBColorSpace);
  scene.add(light, light.target);

  // A frosted glass sheet far behind everything: it catches the light and gives the navy its soft glow.
  scene.add(place(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), backdropMat), { position: [0, 0, -12.258], scale: [40, 40, 1] }));

  // Three glass shapes: a coil of stepped slats, a fan of concentric arcs, and a ribbon of tiles. Each sits in a
  // holder that the timeline moves about the frame; inside it the shape animates itself as the page scrolls.
  const shapes = (
    [
      ["coil", createCoil(glass)],
      ["fan", createFan(glass)],
      ["sweep", createSweep(glass)],
    ] as const
  ).map(([name, shape]) => {
    const holder = new THREE.Group();
    holder.add(shape.object);
    scene.add(holder);
    return { name, holder, shape };
  });

  const setTime = (t: number) => {
    applyTracks(light, TRACKS.light, t);
    for (const { name, holder, shape } of shapes) {
      applyTracks(holder, TRACKS[name], t);
      shape.update(t);
    }
    backdropMat.roughness = sample(BACKDROP_ROUGHNESS, t);
  };

  const dispose = () => {
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
      if (o instanceof THREE.InstancedMesh) o.dispose();
    });
    glass.dispose();
    backdropMat.dispose();
  };

  return { scene, setTime, dispose, parts: { glass, backdropMat, light } };
}

/**
 * Fits the camera to a canvas of this size. Landscape screens all get the same vertical framing; on narrower ones
 * the camera pulls back until at least MIN_HALF_WIDTH of the scene fits across, so the wheels shrink rather than
 * being cropped away at the sides.
 */
function fitCamera(camera: THREE.PerspectiveCamera, w: number, h: number) {
  camera.aspect = w / h;
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * camera.position.z;
  camera.zoom = Math.min(1, (halfHeight * camera.aspect) / MIN_HALF_WIDTH);
  camera.updateProjectionMatrix();
}

export default function SceneBackground({ dim = false }: { dim?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance", stencil: false, depth: true });
    } catch {
      return; // No WebGL: the CSS gradient on .scene-bg stays as the whole background.
    }
    renderer.toneMapping = THREE.NoToneMapping; // tone mapping happens in the effect chain
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    host.prepend(renderer.domElement);

    const { scene, setTime, dispose, parts } = buildScene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);
    camera.position.set(0, 0, 8.4);

    const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 4 });
    const renderPass = new RenderPass(scene, camera);
    const vignette = new VignetteEffect({ offset: 0.2048, darkness: 1 });
    vignette.blendMode.opacity.value = 0.5;
    const grain = new GrainEffect();
    grain.setPixelRatio(renderer.getPixelRatio());
    const beams = new BeamsEffect();
    const effects = [
      beams,
      new BloomEffect({ intensity: 0.6, luminanceThreshold: 0.9, luminanceSmoothing: 0.0285, radius: 0.46, mipmapBlur: true }),
      vignette,
      new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
      new HueSaturationEffect({ saturation: -0.3 }),
      grain,
    ];
    const mainPass = new EffectPass(camera, ...effects);
    const smaaPass = new EffectPass(camera, new SMAAEffect());
    composer.addPass(renderPass);
    composer.addPass(mainPass);
    composer.addPass(smaaPass);

    // ---- Timeline position from scroll ----
    const readAnchors = () =>
      [...document.querySelectorAll<HTMLElement>("[data-scene-anchor]")].map((el) => ({
        y: el.getBoundingClientRect().top + window.scrollY,
        t: Number(el.dataset.sceneAnchor),
      }));
    let anchors = dim ? [] : readAnchors();
    // Dev only: window.__scene.freeze(t) holds the timeline at t (0 to 1), freeze(null) hands it back to scroll.
    let frozen: number | null = null;
    if (import.meta.env.DEV) {
      (window as unknown as { __scene: object }).__scene = { freeze: (t: number | null) => (frozen = t), parts, scene, camera, THREE };
    }
    const timeline = () =>
      frozen ??
      (dim
        ? DIM_T
        : Math.min(1, Math.max(0, scrollToTimeline(Math.max(0, window.scrollY), window.innerHeight, document.documentElement.scrollHeight, anchors))));

    // ---- Size ----
    const resize = () => {
      // The canvas, not the host: on phones it is taller than the screen (see .scene-bg canvas in globals.css).
      const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
      fitCamera(camera, w, h);
      composer.setSize(w, h, false);
      if (!dim) anchors = readAnchors();
    };

    const draw = () => {
      const t = timeline();
      setTime(t);
      beams.t = t;
      composer.render();
    };

    let frame = 0;
    const loop = () => {
      draw();
      frame = requestAnimationFrame(loop);
    };
    const onVisibility = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (!document.hidden) frame = requestAnimationFrame(loop);
    };

    resize();
    const ro = new ResizeObserver(() => {
      resize();
      if (dim) draw();
    });
    ro.observe(renderer.domElement);
    // Anchors move when content above them grows (fonts, images, reveals): re-measure when the page's size changes.
    const pageRo = dim ? null : new ResizeObserver(() => (anchors = readAnchors()));
    pageRo?.observe(document.body);

    if (dim) {
      draw();
    } else {
      document.addEventListener("visibilitychange", onVisibility);
      frame = requestAnimationFrame(loop);
    }
    host.dataset.ready = "";

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      pageRo?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      composer.dispose();
      dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [dim]);

  return <div ref={hostRef} className={`scene-bg${dim ? " is-dim" : ""}`} aria-hidden="true" />;
}
