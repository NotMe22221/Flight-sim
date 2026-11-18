/**
 * Cockpit glass with rain on it (replaces the nearly clear interior glass material): beads that sit
 * on the glass while slow and get blown off as speed builds, and streaks that run up the windscreen
 * and aft along the side windows in flight. Procedural, in the glass's own object-space coordinates, so
 * drops stay put on the glass as the view moves. Dry glass looks exactly like the old material.
 *
 *  - `setRain(target)`: 0 dry … 1 heavy rain. The glass wets within ~10 s and dries over ~1 min
 *    (faster at speed).
 *  - `update(dt, tasMs)` advances the drops; `setLight(f)` scales them with the cabin light.
 */
import * as THREE from 'three';

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vPos;
varying vec3 vN;
void main() {
  vPos = position;
  vN = normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uRain;
uniform float uSpeed;
uniform float uTime;
uniform float uLight;
uniform vec3 uBase;
uniform float uBaseAlpha;
varying vec3 vPos;
varying vec3 vN;
vec3 rgHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}
void main() {
  #include <logdepthbuf_fragment>
  float m = 0.0, hl = 0.0;
  if (uRain > 0.001) {
    // side windows (normal mostly sideways) run along the fuselage; the windscreen across it
    bool side = abs(vN.x) > 0.55;
    vec2 uv = side ? vec2(-vPos.z, vPos.y) : vec2(vPos.x, vPos.y);
    vec2 flow = side ? normalize(vec2(1.0, 0.2)) : vec2(0.0, 1.0);
    float sp = clamp((uSpeed - 12.0) / 40.0, 0.0, 1.0);
    // beads: ~2 cm cells, each maybe holding a drop that forms, sits and is blown off
    {
      vec2 g = uv * 48.0;
      vec2 id = floor(g); vec2 f = fract(g) - 0.5; vec3 h = rgHash(id + 17.0);
      float present = step(1.0 - uRain * (1.0 - 0.8 * sp) * 0.85, h.z);
      float life = fract(uTime * (0.05 + 0.5 * sp) + h.x * 7.0);
      float r = mix(0.1, 0.32, h.y) * smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.8, 1.0, life));
      vec2 c = (h.xy - 0.5) * 0.5 + flow * sp * (life - 0.5) * 0.6;
      float d = length(f - c);
      m = max(m, present * (1.0 - smoothstep(r * 0.7, r, d)));
      hl = max(hl, present * step(0.02, r) * (1.0 - smoothstep(0.0, r * 0.3, length(f - c - vec2(-0.3, 0.35) * r))));
    }
    // streaks: long cells along the flow, scrolling with speed
    if (sp > 0.0) {
      vec2 ac = vec2(-flow.y, flow.x);
      float s = dot(uv, flow), q = dot(uv, ac);
      vec2 g = vec2(q * 55.0, s * 5.0 - uTime * (0.6 + 5.0 * sp));
      vec2 id = floor(g); vec2 f = fract(g) - 0.5; vec3 h = rgHash(id + 3.0);
      float present = step(1.0 - uRain * sp * 0.55, h.z);
      float x = f.x - (h.x - 0.5) * 0.5;
      float head = (h.y - 0.5) * 0.4;
      float w = mix(0.08, 0.2, h.y);
      float body = (1.0 - smoothstep(w * 0.5, w, abs(x))) * smoothstep(-0.5, head, f.y) * step(f.y, head);
      m = max(m, present * body * 0.75);
    }
  }
  vec3 col = mix(uBase, vec3(0.92, 0.95, 1.0), m) * uLight + vec3(hl) * 0.8 * uLight;
  gl_FragColor = vec4(col, clamp(uBaseAlpha + m * 0.3 + hl * 0.35, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class RainGlass {
  readonly material: THREE.ShaderMaterial;
  private level = 0;
  private target = 0;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      name: 'rain-glass',
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uRain: { value: 0 }, uSpeed: { value: 0 }, uTime: { value: 0 }, uLight: { value: 1 },
        // the old interior glass: 0xb8c4d0 at 6 % (linear colour)
        uBase: { value: new THREE.Color(0xb8c4d0) }, uBaseAlpha: { value: 0.06 },
      },
    });
  }

  /** Current wetness 0…1 (eased). */
  get wetness(): number { return this.level; }

  setRain(target: number): void { this.target = Number.isFinite(target) ? Math.max(0, Math.min(1, target)) : 0; }

  /** Cabin light scale (≈ 0.05 at night … 1 at noon, before the tone mapping). */
  setLight(f: number): void { if (Number.isFinite(f)) this.material.uniforms.uLight.value = f; }

  update(dtS: number, tasMs: number): void {
    if (!(dtS > 0)) return;
    const u = this.material.uniforms;
    const wetting = this.target > this.level;
    // wets in ~10 s; dries in ~60 s at rest, ~20 s in cruise (the airflow clears the glass)
    const tau = wetting ? 10 : 60 / (1 + Math.max(0, tasMs) / 25);
    this.level += (this.target - this.level) * (1 - Math.exp(-dtS / tau));
    if (this.level < 0.002 && this.target === 0) this.level = 0;
    u.uRain.value = this.level;
    u.uSpeed.value = Number.isFinite(tasMs) ? tasMs : 0;
    u.uTime.value = (u.uTime.value + dtS) % 1000;
  }

  dispose(): void { this.material.dispose(); }
}
