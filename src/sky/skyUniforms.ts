/**
 * Uniform objects the sky publishes for other renderers' shaders (terrain, ocean, scenery), so they
 * light, reflect and shadow consistently with the sky without per-frame plumbing: a material spreads
 * these `{ value }` objects into its `uniforms` (by reference) and sees every update `SkySystem` makes.
 *
 * `SKY_UNIFORMS` is the process-wide default instance: `SkySystem` writes it every frame unless given
 * `sharedUniforms: null` (or its own instance), and `TerrainSystem` reads it unless given its own.
 * Consumers must treat `uSkyLinked.value === 0` as "no sky yet" and use their own inputs.
 *
 * Colours are linear. `uSkyIrradiance` is in three's light units (what a HemisphereLight sky colour ×
 * intensity plus the ambient floor give an up-facing surface: radiance = albedo/π · irradiance);
 * `uSkyZenith`/`uSkyHorizon` are sky radiance in the dome's Preetham scale (what the dome shows), for
 * mirror reflections.
 *
 * Cloud shadows: per layer i < `uCloudShadowCount` (max `MAX_SHADOW_LAYERS`),
 *   `uCloudShadowA[i]` = (coverage, 1 / featureSize, unused, column optical depth at density 1 = (top − base)·density·σt)
 *   `uCloudShadowB[i]` = (render-y of the layer middle, drift x, drift z, unused)
 * with the same noise field as the cloud planes (`CLOUD_SHADOW_GLSL` below, `CLOUD_NOISE_GLSL` in cloudMath).
 * The transmittance along the sun ray is floored at `uCloudShadowFloor` and multiplied by
 * `uCloudShadowNorm` = 1 / (mean cloud dimming already applied to the sun intensity), so a lit gap gets the
 * unobstructed sun and the average over the ground matches the dimmed sun the built-in materials receive.
 */
import { Color, Vector4 } from 'three';
import { CLOUD_NOISE_GLSL, coverageMask, fbm2 } from './cloudMath';

export const MAX_SHADOW_LAYERS = 4;

export interface SkySharedUniforms {
  /** 1 once a `SkySystem` has published into this instance, else 0 */
  uSkyLinked: { value: number };
  /** ambient irradiance of an up-facing surface (sky hemisphere + ambient floor), linear, three light units */
  uSkyIrradiance: { value: Color };
  /** sky radiance at the zenith, linear, dome (Preetham) scale */
  uSkyZenith: { value: Color };
  /** sky radiance at +1° averaged over azimuth, linear, dome scale */
  uSkyHorizon: { value: Color };
  /** current tone-mapping exposure (informational; three applies it in `tonemapping_fragment`) */
  uSkyExposure: { value: number };
  /** number of cloud layers casting shadows (0 … MAX_SHADOW_LAYERS) */
  uCloudShadowCount: { value: number };
  uCloudShadowA: { value: Vector4[] };
  uCloudShadowB: { value: Vector4[] };
  /** 0 = no cloud shadows (sun down, no clouds), 1 = full */
  uCloudShadowStrength: { value: number };
  /** lowest transmittance a shadow reaches (the overcast floor of the sun dimming) */
  uCloudShadowFloor: { value: number };
  /** 1 / mean dimming already applied to the sun intensity by cloud cover */
  uCloudShadowNorm: { value: number };
}

export function createSkySharedUniforms(): SkySharedUniforms {
  const a: Vector4[] = [], b: Vector4[] = [];
  for (let i = 0; i < MAX_SHADOW_LAYERS; i++) { a.push(new Vector4()); b.push(new Vector4()); }
  return {
    uSkyLinked: { value: 0 },
    uSkyIrradiance: { value: new Color(0.3, 0.4, 0.6) },
    uSkyZenith: { value: new Color(0.1, 0.25, 0.6) },
    uSkyHorizon: { value: new Color(0.6, 0.7, 0.8) },
    uSkyExposure: { value: 0.6 },
    uCloudShadowCount: { value: 0 },
    uCloudShadowA: { value: a },
    uCloudShadowB: { value: b },
    uCloudShadowStrength: { value: 0 },
    uCloudShadowFloor: { value: 0.15 },
    uCloudShadowNorm: { value: 1 },
  };
}

/** Process-wide default instance (written by `SkySystem`, read by `TerrainSystem`). */
export const SKY_UNIFORMS: SkySharedUniforms = createSkySharedUniforms();

/**
 * GLSL for consumers: the uniform declarations above plus `skyCloudShadow(worldPos, sunDir)` → factor to
 * multiply the direct sun term by (1 where no layer, ≥ floor·norm in a shadow, norm in a gap).
 * Needs `#define CLOUD_OCTAVES n` (the material's `defines`) for the shared noise.
 */
export const SKY_UNIFORMS_GLSL = /* glsl */ `
uniform float uSkyLinked;
uniform vec3 uSkyIrradiance;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform float uCloudShadowCount;
uniform vec4 uCloudShadowA[ ${MAX_SHADOW_LAYERS} ];
uniform vec4 uCloudShadowB[ ${MAX_SHADOW_LAYERS} ];
uniform float uCloudShadowStrength;
uniform float uCloudShadowFloor;
uniform float uCloudShadowNorm;
${CLOUD_NOISE_GLSL}
float skyCloudShadow( vec3 worldPos, vec3 sunDir ) {
  if ( uCloudShadowStrength <= 0.0 || uCloudShadowCount < 0.5 ) return 1.0;
  float sy = max( sunDir.y, 0.12 );
  float tr = 1.0;
  for ( int i = 0; i < ${MAX_SHADOW_LAYERS}; i ++ ) {
    if ( float( i ) >= uCloudShadowCount ) break;
    vec4 a = uCloudShadowA[ i ];
    vec4 b = uCloudShadowB[ i ];
    // where the sun ray through this point crosses the layer middle
    vec2 q = worldPos.xz + sunDir.xz * ( ( b.x - worldPos.y ) / sy );
    float dens = cloudCoverageMask( cloudFbm( ( q - b.yz ) * a.y ), a.x );
    tr *= exp( - a.w * dens / sy );
  }
  float f = max( tr, uCloudShadowFloor ) * uCloudShadowNorm;
  return mix( 1.0, f, uCloudShadowStrength );
}
`;

/**
 * CPU twin of `skyCloudShadow` (same layers, noise, floor and normalisation): the factor on the direct sun
 * at a render-frame point. `SkySystem` applies it at the aircraft to the sun light of the built-in
 * materials (aircraft, runways, buildings), so they darken with the ground when a cloud shadow passes.
 */
export function cloudShadowAt(u: SkySharedUniforms, x: number, y: number, z: number, sunX: number, sunY: number, sunZ: number): number {
  const strength = u.uCloudShadowStrength.value;
  const n = Math.min(u.uCloudShadowCount.value, MAX_SHADOW_LAYERS);
  if (!(strength > 0) || n < 1) return 1;
  const sy = Math.max(sunY, 0.12);
  let tr = 1;
  for (let i = 0; i < n; i++) {
    const a = u.uCloudShadowA.value[i], b = u.uCloudShadowB.value[i];
    const t = (b.x - y) / sy;
    const qx = x + sunX * t, qz = z + sunZ * t;
    const dens = coverageMask(fbm2((qx - b.y) * a.y, (qz - b.z) * a.y, 3), a.x);
    tr *= Math.exp((-a.w * dens) / sy);
  }
  const f = Math.max(tr, u.uCloudShadowFloor.value) * u.uCloudShadowNorm.value;
  return 1 + (f - 1) * strength;
}
