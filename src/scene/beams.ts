import { Effect, EffectAttribute } from "postprocessing";
import { Uniform, Vector3 } from "three";

/**
 * Soft shafts of light slanting down across the frame, like studio light through haze. They are defined in screen
 * space (so they frame the page the same way at any scroll depth) and slide sideways with the timeline, so they
 * sweep slowly across as the page scrolls and never move on their own.
 *
 * `beamLight(uv, aspect, t)` gives the light at a screen position (0 to about 1).
 */
export const BEAMS_GLSL = /* glsl */ `
float beamShaft(vec2 p, float aspect, float t, float angle, float base, float drift, float width, float strength) {
  vec2 across = vec2(cos(angle), sin(angle));
  // Slide with the timeline, wrapping round a span a little wider than the frame so a beam leaves one side before
  // it comes back in at the other.
  float span = aspect + 1.2;
  float offset = mod(base + t * drift + span * 0.5, span) - span * 0.5;
  float d = dot(p, across) - offset;
  float shaft = exp(-(d * d) / (width * width));
  // Fine streaks running along the beam, as in light through dusty air.
  float streaks = 0.7 + 0.18 * sin(d * 90.0 + base * 17.0) + 0.12 * sin(d * 37.0 + base * 5.0);
  return shaft * streaks * strength;
}

float beamLight(vec2 uv, float aspect, float t) {
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float light = 0.0;
  light += beamShaft(p, aspect, t, -0.42, -0.55, 1.6, 0.16, 1.0);
  light += beamShaft(p, aspect, t, -0.36, 0.1, 1.1, 0.07, 0.7);
  light += beamShaft(p, aspect, t, -0.47, 0.55, 1.9, 0.24, 0.8);
  light += beamShaft(p, aspect, t, -0.4, 1.05, 1.3, 0.1, 0.6);
  // The light comes from above: full at the top of the frame, fading out towards the bottom.
  return light * smoothstep(-0.75, 0.45, p.y);
}
`;

const fragmentShader = /* glsl */ `
uniform float uT;
uniform float uAspect;
uniform float uStrength;
uniform vec3 uColor;

${BEAMS_GLSL}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  // Full strength on the far backdrop; only a faint haze where a beam passes in front of the wheels, so the glass
  // stays dark and crisp.
  float far = smoothstep(14.0, 18.0, -getViewZ(depth));
  float light = beamLight(uv, uAspect, uT) * mix(0.12, 1.0, far);
  outputColor = vec4(inputColor.rgb + uColor * light * uStrength, inputColor.a);
}
`;

export class BeamsEffect extends Effect {
  constructor({ strength = 0.16, color = [0.42, 0.6, 1.0] as [number, number, number] } = {}) {
    super("BeamsEffect", fragmentShader, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ["uT", new Uniform(0)],
        ["uAspect", new Uniform(1)],
        ["uStrength", new Uniform(strength)],
        ["uColor", new Uniform(new Vector3(...color))],
      ]),
    });
  }

  set t(value: number) {
    this.uniforms.get("uT")!.value = value;
  }

  setSize(width: number, height: number) {
    this.uniforms.get("uAspect")!.value = width / height;
  }
}
