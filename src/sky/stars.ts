/**
 * Night star field: ~3000 deterministic stars (seeded magnitudes, colours and J2000 equatorial
 * positions) rendered as one additive `Points` draw, rotated each frame with local sidereal time
 * so the sky turns about the celestial pole. Positions are drawn at the far plane (depth-tested
 * so terrain occludes them) in both normal and reversed-depth modes.
 */
import * as THREE from 'three';
import { clamp, mulberry32 } from '../core/math';
import { julianDay } from '../geo/solar';

const D2R = Math.PI / 180;

/** Greenwich mean sidereal time, degrees (Meeus 12.4). */
export function gmstDeg(utcMs: number): number {
  const d = julianDay(utcMs) - 2_451_545;
  const T = d / 36_525;
  const g = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - (T * T * T) / 38_710_000;
  return ((g % 360) + 360) % 360;
}

/** J2000 equatorial unit vector (x → RA 0, z → north celestial pole) from RA/Dec in degrees. */
export function equatorialDir(raDeg: number, decDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const ra = raDeg * D2R, dec = decDeg * D2R;
  return out.set(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
}

const rotZ = new THREE.Matrix4();
const tilt = new THREE.Matrix4();

/**
 * Rotation taking J2000 equatorial unit vectors into the render frame (x East, y Up, z South) for
 * an observer at `latDeg`/`lonDeg` at time `utcMs`. Rotate about the pole by −LST, then map the
 * rotated axes: x' (local meridian, dec 0) → (0, cos φ, sin φ) [south, elevation 90°−φ],
 * y' → East, z' (celestial pole) → (0, sin φ, −cos φ).
 */
export function equatorialToLocalMatrix(utcMs: number, latDeg: number, lonDeg: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  const lst = (gmstDeg(utcMs) + lonDeg) * D2R;
  const phi = latDeg * D2R;
  const c = Math.cos(phi), s = Math.sin(phi);
  rotZ.makeRotationZ(-lst);
  tilt.set(
    0, 1, 0, 0,
    c, 0, s, 0,
    s, 0, -c, 0,
    0, 0, 0, 1,
  );
  return out.multiplyMatrices(tilt, rotZ);
}

/** Approximate blackbody colour (linear RGB, normalised to max 1) for 2500–15000 K. */
export function blackbodyRGB(tempK: number, out = new THREE.Color()): THREE.Color {
  const t = clamp(tempK, 1000, 40_000) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); b = 255; }
  r = clamp(r, 0, 255) / 255; g = clamp(g, 0, 255) / 255; b = clamp(b, 0, 255) / 255;
  // sRGB-ish → linear
  out.setRGB(r * r, g * g, b * b);
  const m = Math.max(out.r, out.g, out.b, 1e-6);
  return out.multiplyScalar(1 / m);
}

export interface StarCatalog {
  count: number;
  /** J2000 equatorial unit vectors, xyz per star */ positions: Float32Array;
  /** visual magnitudes */ magnitudes: Float32Array;
  /** linear RGB per star */ colors: Float32Array;
}

/**
 * Deterministic synthetic catalogue: uniform directions, magnitudes following N(<m) ∝ 10^(0.5 m)
 * (the real sky's slope) between −1.5 and 6.5, colours from a B−V-like distribution.
 */
export function generateStarCatalog(count = 3000, seed = 12345): StarCatalog {
  const rnd = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const magnitudes = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const z = 2 * rnd() - 1, phi = 2 * Math.PI * rnd();
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    positions[i * 3] = r * Math.cos(phi); positions[i * 3 + 1] = r * Math.sin(phi); positions[i * 3 + 2] = z;
    const u = Math.max(rnd(), 1e-6);
    magnitudes[i] = clamp(6.5 + 2 * Math.log10(u), -1.5, 6.5);
    // colour: mostly white/yellow, some blue and red
    const bv = -0.3 + 2.0 * Math.pow(rnd(), 1.6);
    const tempK = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
    blackbodyRGB(tempK, col);
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  return { count, positions, magnitudes, colors };
}

const VERT = /* glsl */ `
attribute float aMag;
attribute vec3 aColor;
uniform float uPixelRatio;
uniform float uGain;
uniform float uVisibility;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * viewMatrix * wp;
  #ifdef USE_REVERSED_DEPTH_BUFFER
    gl_Position.z = 0.0;
  #else
    gl_Position.z = gl_Position.w;
  #endif
  gl_PointSize = clamp( 3.0 - 0.4 * aMag, 1.0, 4.0 ) * uPixelRatio;
  float flux = pow( 10.0, - 0.4 * aMag ) * uGain;
  vColor = aColor * flux;
  vec3 dir = normalize( wp.xyz - cameraPosition );
  vAlpha = uVisibility * smoothstep( - 0.02, 0.08, dir.y );
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = exp( - dot( c, c ) * 14.0 ) * vAlpha;
  if ( a < 0.002 ) discard;
  gl_FragColor = vec4( vColor, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** The renderable star field. Add `points` to the scene; call `update` every frame. */
export class StarField {
  readonly points: THREE.Points;
  readonly catalog: StarCatalog;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly matrix = new THREE.Matrix4();

  constructor(count = 3000, seed = 12345, radiusM = 1000) {
    this.catalog = generateStarCatalog(count, seed);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.catalog.positions, 3));
    this.geometry.setAttribute('aMag', new THREE.BufferAttribute(this.catalog.magnitudes, 1));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.catalog.colors, 3));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uPixelRatio: { value: 1 }, uGain: { value: 2.0 }, uVisibility: { value: 0 } },
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.scale.setScalar(radiusM);
    this.points.visible = false;
    this.points.name = 'stars';
  }

  /** Brightness gain: m = 0 saturates after tone mapping at night exposure with ≈ 2. */
  set gain(v: number) { this.material.uniforms.uGain.value = v; }
  get gain(): number { return this.material.uniforms.uGain.value as number; }

  /** @param visibility 0..1 star alpha (from `starVisibility`) */
  update(utcMs: number, latDeg: number, lonDeg: number, cameraPos: THREE.Vector3, visibility: number, pixelRatio = 1): void {
    this.points.visible = visibility > 0.002;
    if (!this.points.visible) return;
    equatorialToLocalMatrix(utcMs, latDeg, lonDeg, this.matrix);
    this.points.quaternion.setFromRotationMatrix(this.matrix);
    this.points.position.copy(cameraPos);
    this.material.uniforms.uVisibility.value = visibility;
    this.material.uniforms.uPixelRatio.value = pixelRatio;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.points.removeFromParent();
  }
}
