import { Effect } from "postprocessing";
import { Uniform, type WebGLRenderer } from "three";

/**
 * Film grain over the whole picture. Unlike postprocessing's NoiseEffect it is:
 *  - sized in CSS pixels (one grain = one CSS pixel), so it reads the same on a 1x screen and a 2x one instead of
 *    shrinking to invisibility on sharp screens;
 *  - applied in display (gamma) space, so `amount` is how far a pixel's shade moves, much like grain on film;
 *  - strongest in the shadows and midtones and softer in the highlights.
 * It re-rolls every frame, like projected film.
 */
const fragmentShader = /* glsl */ `
uniform float uAmount;
uniform float uCell;
uniform float uSeed;

float grainHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21) + uSeed);
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 cell = floor(gl_FragCoord.xy / uCell);
  // Two uniform draws make a triangular distribution: grain that clusters round zero, like real film.
  float n = grainHash(cell) + grainHash(cell + 17.13) - 1.0;
  vec3 shade = pow(max(inputColor.rgb, 0.0), vec3(1.0 / 2.2));
  float luma = dot(shade, vec3(0.299, 0.587, 0.114));
  shade += n * uAmount * mix(1.0, 0.45, smoothstep(0.35, 0.95, luma));
  outputColor = vec4(pow(max(shade, 0.0), vec3(2.2)), inputColor.a);
}
`;

export class GrainEffect extends Effect {
  constructor({ amount = 0.085 } = {}) {
    super("GrainEffect", fragmentShader, {
      uniforms: new Map<string, Uniform>([
        ["uAmount", new Uniform(amount)],
        ["uCell", new Uniform(1)],
        ["uSeed", new Uniform(0)],
      ]),
    });
  }

  /** Grain cell size in drawing-buffer pixels: one CSS pixel at the renderer's pixel ratio. */
  setPixelRatio(ratio: number) {
    this.uniforms.get("uCell")!.value = Math.max(1, ratio);
  }

  update(_renderer: WebGLRenderer) {
    this.uniforms.get("uSeed")!.value = Math.random() * 100;
  }
}
