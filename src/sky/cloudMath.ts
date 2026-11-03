/**
 * CPU twin of the cloud-layer plane shader (clouds.ts): value-noise fbm, coverage threshold, detail
 * erosion and vertical profile. Used for `cloudDensityAt()` (FDM bumpiness, visibility, in-cloud fog) and for
 * tests. The GLSL in `CLOUD_NOISE_GLSL` uses the same hash/noise so the CPU and GPU fields agree
 * statistically (float32 vs float64 rounding means they are not bit-identical).
 */
import { clamp, smoothstep } from '../core/math';
import type { CloudLayer } from '../core/types';

/** Softness of the coverage threshold (fraction of the noise range). */
export const COVERAGE_SOFTNESS = 0.25;
/** Fraction of the layer thickness over which density feathers in at the base and top. */
export const VERTICAL_FEATHER = 0.12;

/** Per-type look parameters shared by the CPU density and the GPU shader. */
export interface CloudTypeParams {
  /** horizontal feature size of the base fbm, m */ featureSizeM: number;
  /** extinction per metre of cloud at density 1 (σ_t) */ sigmaT: number;
  /** multiplier on the sun term (cirrus is thin and bright) */ brightness: number;
  /** multiplier on the detail erosion */ erosion: number;
}

const CIRRUS: Readonly<CloudTypeParams> = Object.freeze({ featureSizeM: 6000, sigmaT: 0.0006, brightness: 1.6, erosion: 0.6 });
const STRATUS: Readonly<CloudTypeParams> = Object.freeze({ featureSizeM: 3500, sigmaT: 0.004, brightness: 0.9, erosion: 0.2 });
const CUMULUS: Readonly<CloudTypeParams> = Object.freeze({ featureSizeM: 2500, sigmaT: 0.006, brightness: 1.0, erosion: 0.4 });

/** Shared frozen constants (called per layer every frame and per FDM density query: no allocation). */
export function cloudTypeParams(type: CloudLayer['type']): Readonly<CloudTypeParams> {
  switch (type) {
    case 'cirrus': return CIRRUS;
    case 'stratus': return STRATUS;
    case 'cumulus':
    default: return CUMULUS;
  }
}

const fract = (x: number): number => x - Math.floor(x);

/** Sinless 2-D hash (same as the GLSL): deterministic on every platform. */
export function hash2(x: number, y: number): number {
  let qx = fract(x * 0.1031), qy = fract(y * 0.1030), qz = fract(x * 0.0973);
  const d = qx * (qy + 33.33) + qy * (qz + 33.33) + qz * (qx + 33.33);
  qx += d; qy += d; qz += d;
  return fract((qx + qy) * qz);
}

/** 2-D value noise 0..1 with a smoothstep fade. */
export function valueNoise2(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** fbm of `octaves` value-noise octaves, normalised to 0..1. */
export function fbm2(x: number, y: number, octaves = 3): number {
  let amp = 0.5, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x, y);
    norm += amp;
    x = x * 2.03 + 17.1; y = y * 2.03 + 17.1;
    amp *= 0.5;
  }
  return sum / norm;
}

/**
 * Coverage mask 0..1 from a 0..1 shape value: a soft threshold such that coverage 0 ⇒ 0 everywhere
 * and coverage 1 ⇒ 1 everywhere (threshold = 1 − c·(1 + softness)).
 */
export function coverageMask(shape: number, coverage: number, softness = COVERAGE_SOFTNESS): number {
  const c = clamp(coverage, 0, 1);
  if (c <= 0) return 0;
  const th = 1 - c * (1 + softness);
  return smoothstep(th, th + softness, shape);
}

/** 0..1 vertical profile: 1 in the body of the layer, feathering to 0 at base and top; 0 outside. */
export function verticalProfile(layer: CloudLayer, y: number): number {
  const thick = Math.max(layer.topM - layer.baseM, 1);
  if (y <= layer.baseM || y >= layer.topM) return 0;
  const f = Math.max(thick * VERTICAL_FEATHER, 1);
  return smoothstep(layer.baseM, layer.baseM + f, y) * (1 - smoothstep(layer.topM - f, layer.topM, y));
}

/**
 * Density 0..1 of one layer at a render-frame point (x East, y Up, z South). `driftX/driftZ` is the
 * accumulated wind drift of the layer's noise field (m).
 */
export function cloudLayerDensityAt(layer: CloudLayer, x: number, y: number, z: number, driftX = 0, driftZ = 0, octaves = 3): number {
  const v = verticalProfile(layer, y);
  if (v <= 0) return 0;
  const p = cloudTypeParams(layer.type);
  const inv = 1 / p.featureSizeM;
  const px = (x - driftX) * inv, pz = (z - driftZ) * inv;
  let mask = coverageMask(fbm2(px, pz, octaves), layer.coverage);
  // detail erosion of the soft edges, exactly as the plane shader (no effect where mask is 0 or 1)
  if (mask > 0 && mask < 1) mask = clamp(mask - (1 - mask) * fbm2(px * 7 + 3.7, pz * 7 + 3.7, octaves) * p.erosion, 0, 1);
  return clamp(mask * v * clamp(layer.density, 0, 1), 0, 1);
}

/** Max density over all layers at a point. `drifts` holds [dx0, dz0, dx1, dz1, …] per layer (optional). */
export function cloudDensityAt(layers: readonly CloudLayer[], x: number, y: number, z: number, drifts?: ArrayLike<number>, octaves = 3): number {
  let d = 0;
  for (let i = 0; i < layers.length; i++) {
    const dx = drifts ? drifts[i * 2] ?? 0 : 0, dz = drifts ? drifts[i * 2 + 1] ?? 0 : 0;
    const v = cloudLayerDensityAt(layers[i], x, y, z, dx, dz, octaves);
    if (v > d) d = v;
  }
  return d;
}

/** GLSL twin of hash2 / valueNoise2 / fbm2 / coverageMask for the cloud plane and terrain shadow shaders. */
export const CLOUD_NOISE_GLSL = /* glsl */ `
float cloudHash( vec2 p ) {
  vec3 q = fract( p.xyx * vec3( 0.1031, 0.1030, 0.0973 ) );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
}
float cloudValueNoise( vec2 p ) {
  vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  float a = cloudHash( i ), b = cloudHash( i + vec2( 1.0, 0.0 ) ), c = cloudHash( i + vec2( 0.0, 1.0 ) ), d = cloudHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float cloudFbm( vec2 p ) {
  float amp = 0.5, sum = 0.0, norm = 0.0;
  for ( int i = 0; i < CLOUD_OCTAVES; i ++ ) {
    sum += amp * cloudValueNoise( p ); norm += amp;
    p = p * 2.03 + 17.1; amp *= 0.5;
  }
  return sum / norm;
}
float cloudCoverageMask( float shape, float coverage ) {
  float th = 1.0 - coverage * ( 1.0 + ${COVERAGE_SOFTNESS.toFixed(3)} );
  return smoothstep( th, th + ${COVERAGE_SOFTNESS.toFixed(3)}, shape ) * step( 0.001, coverage );
}
`;
