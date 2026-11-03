/**
 * Pure lighting / exposure / fog curves driven by sun elevation and weather. No Three.js here so
 * every curve is unit-testable; `SkySystem` feeds the results into lights, fog and the renderer.
 *
 * Colour conventions: tuples are linear RGB in the renderer's working colour space (linear-sRGB).
 * `acesFilmic` + `linearToSrgb` reproduce Three.js r187 `ACESFilmicToneMapping` + output encoding
 * so a CPU-computed colour can match what a shader produces for the same radiance.
 */
import { clamp, lerp, smoothstep } from '../core/math';
import type { CloudLayer, Vec3 } from '../core/types';

/** Exposure (eye adaptation) targets, all exposed as `SkySystem` options. */
export interface ExposureOptions {
  /** bright day; the Three.js sky example uses 0.5 */ day: number;
  /** civil twilight */ twilight: number;
  /** deep night (moonless night is slightly higher) */ night: number;
  /** extra relative exposure under a full overcast (darker scene → eye opens) */ overcastBoost: number;
  /** adaptation time constant, s */ adaptTimeS: number;
}

export const DEFAULT_EXPOSURE: Readonly<ExposureOptions> = { day: 0.6, twilight: 1.0, night: 1.5, overcastBoost: 0.4, adaptTimeS: 1.5 };

/** Relative luminance (Rec. 709 weights) of a linear RGB tuple. */
export const luminance = (c: ArrayLike<number>): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Total cloud cover 0..1 from independent layers: 1 − Π(1 − coverage). */
export function cloudCoverFraction(layers: readonly CloudLayer[]): number {
  let clear = 1;
  for (const l of layers) clear *= 1 - clamp(l.coverage, 0, 1) * clamp(l.density, 0, 1);
  return 1 - clear;
}

/**
 * Deterministic auto-exposure target from sun elevation (deg) and cloud cover.
 * Monotonically decreasing in elevation; bounded by [day, night·(1 + 0.15)] (moonless night).
 */
export function targetExposure(sunElDeg: number, cloudCover: number, moonFraction: number, o: ExposureOptions = DEFAULT_EXPOSURE): number {
  const night = o.night * (1 + 0.15 * (1 - clamp(moonFraction, 0, 1)));
  const tDawn = smoothstep(-6, 8, sunElDeg); // twilight → day
  const tNight = smoothstep(-18, -6, sunElDeg); // night → twilight
  let e = lerp(lerp(night, o.twilight, tNight), o.day, tDawn);
  e *= 1 + o.overcastBoost * clamp(cloudCover, 0, 1) * tDawn;
  return e;
}

/** First-order adaptation step: `exposure += (target − exposure)·(1 − exp(−dt/τ))`. */
export const adaptExposure = (current: number, target: number, dt: number, tauS: number): number =>
  current + (target - current) * (1 - Math.exp(-Math.max(dt, 0) / Math.max(tauS, 1e-3)));

/**
 * Sun DirectionalLight intensity. `transmittance` is the Preetham extinction toward the sun
 * (its luminance falls from ≈0.87 at the zenith to ≈0.04 at the horizon, which reproduces the
 * dimming of a low sun); `base` ≈ 3 gives ≈100 klx-equivalent under exposure 0.6 with ACES.
 */
export function sunLightIntensity(sunElDeg: number, transmittance: Vec3, cloudCover: number, base = 3): number {
  const disc = smoothstep(-1.5, 3, sunElDeg); // disc rising over the horizon
  const lum = clamp(luminance(transmittance), 0, 1);
  return base * disc * lum * (1 - 0.85 * clamp(cloudCover, 0, 1));
}

/** Sun light colour: transmittance normalised so the brightest channel is 1 (hue only; magnitude lives in the intensity). */
export function normalizeColor(c: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const m = Math.max(c[0], c[1], c[2], 1e-6);
  out[0] = c[0] / m; out[1] = c[1] / m; out[2] = c[2] / m;
  return out;
}

/** Approximate correlated colour temperature (K) of a linear RGB colour via McCamy's formula. Informational (UI). */
export function colorTemperatureK(c: Vec3): number {
  // linear sRGB → XYZ (D65)
  const X = 0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2];
  const Y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const Z = 0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2];
  const s = X + Y + Z || 1;
  const x = X / s, y = Y / s;
  const n = (x - 0.332) / (0.1858 - y);
  return 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
}

/** HemisphereLight intensity: skylight without direct sun. Rises through twilight, slightly higher under cloud (diffuse). */
export function hemisphereIntensity(sunElDeg: number, cloudCover: number): number {
  return lerp(0.02, 0.9, smoothstep(-12, 10, sunElDeg)) * (1 + 0.3 * clamp(cloudCover, 0, 1));
}

/**
 * AmbientLight floor so the night is never pitch black (starlight + airglow + city glow + moon fill), for
 * the `NIGHT_AMBIENT_COLOR` hue (luminance ≈ 0.53): ≈ 0.12 luminance moonless, ≈ 0.24 under a full moon —
 * after ACES's toe that leaves a grass field at ≈ 11/255 and ≈ 25/255 (dark, never black).
 */
export function ambientFloor(sunElDeg: number, moonFraction: number, moonElDeg: number): number {
  const night = 1 - smoothstep(-12, 0, sunElDeg);
  const moon = clamp(moonFraction, 0, 1) * smoothstep(-2, 10, moonElDeg);
  return night * (0.22 + 0.22 * moon);
}

/** Linear hue of the night ambient floor (night-adapted blue). */
export const NIGHT_AMBIENT_COLOR: Readonly<Vec3> = [0.42, 0.52, 1.0];

/** Illuminance (three light units) of a sunlit up-facing surface at midday; the day exposure applies there. */
export const DAY_ILLUMINANCE = 1.8;

/** Illuminance proxy of an up-facing surface: direct sun · sin(el) + ambient irradiance luminance. */
export function surfaceIlluminance(sunIntensity: number, sunElDeg: number, ambientLuminance: number): number {
  return Math.max(sunIntensity, 0) * Math.max(Math.sin(sunElDeg * (Math.PI / 180)), 0) + Math.max(ambientLuminance, 0);
}

/**
 * Exposure target from the scene illuminance (partial eye adaptation): day · (E_day / E)^power, bounded by
 * [day, night·(1 + 0.15·(1 − moon))]. Dawn/dusk (sun ≈ 1–3°, mostly skylight) land near the night bound so
 * the ground stays readable; an overcast noon opens up ≈ 1.7×; the deterministic curve has no read-back.
 */
export function exposureForIlluminance(illuminance: number, moonFraction: number, o: ExposureOptions = DEFAULT_EXPOSURE, power = 0.5): number {
  const night = Math.max(o.night * (1 + 0.15 * (1 - clamp(moonFraction, 0, 1))), o.day);
  const e = o.day * Math.pow(DAY_ILLUMINANCE / Math.max(illuminance, 1e-4), power);
  return clamp(e, o.day, night);
}

/** Moonlight DirectionalLight intensity ≈ 0.25 lx full moon vs 100 klx sun, boosted so it reads after night exposure. */
export function moonLightIntensity(moonElDeg: number, illuminatedFraction: number, cloudCover: number, sunElDeg: number): number {
  const up = smoothstep(-1, 5, moonElDeg);
  const dark = 1 - smoothstep(-10, -2, sunElDeg); // irrelevant by day
  return 0.08 * clamp(illuminatedFraction, 0, 1) * up * dark * (1 - 0.9 * clamp(cloudCover, 0, 1));
}

/** Star alpha 0..1: fades in from civil to nautical twilight, hidden by cloud. */
export function starVisibility(sunElDeg: number, cloudCover: number): number {
  return (1 - smoothstep(-12, -3, sunElDeg)) * (1 - clamp(cloudCover, 0, 1));
}

/** Preetham turbidity (2 clear … 10 hazy) from meteorological visibility (m) and the aerosol slider. */
export function turbidityFromVisibility(visibilityM: number, aerosol: number): number {
  const tVis = 2 + 8 * (1 - Math.min(Math.max(visibilityM, 1), 20_000) / 20_000);
  return clamp(Math.max(tVis, 2 + 8 * clamp(aerosol, 0, 1)), 2, 10);
}

/** Mie coefficient for the sky dome: more forward-scattering haze as visibility drops. */
export function mieFromVisibility(visibilityM: number, aerosol: number): number {
  const haze = Math.max(1 - Math.min(Math.max(visibilityM, 1), 30_000) / 30_000, clamp(aerosol, 0, 1));
  return lerp(0.003, 0.03, haze);
}

/** Koschmieder extinction coefficient β (m⁻¹) for a 2 % contrast threshold: β = 3.912 / V. */
export const fogBetaFromVisibility = (visibilityM: number): number => 3.912 / Math.max(visibilityM, 10);

/**
 * `THREE.FogExp2` density that reproduces the same 2 % residual contrast at the visibility distance:
 * exp(−d²V²) = 0.02 ⇒ d = 1.978 / V.
 */
export const fogExp2DensityFromVisibility = (visibilityM: number): number => 1.9780 / Math.max(visibilityM, 10);

/** Smallest `fogHeightFalloff` published (m⁻¹): a 100 km scale height ≈ homogeneous fog. */
export const MIN_FOG_INV_H = 1e-5;

/**
 * Optical depth ∫₀^dist β0·exp(−h(s)·invH) ds along a unit ray that starts `h0` m above the fog's ground
 * reference with vertical component `dirY` — the closed form of Quilez's "better fog",
 * β0·e^(−h0·invH)·dist·(1 − e^(−k))/k with k = dist·dirY·invH. Written so it stays finite for any input
 * (k → 0 series, clamped exponents, exact homogeneous limit for invH = 0). CPU twin of `HEIGHT_FOG_GLSL`.
 */
export function heightFogOpticalDepth(h0: number, dirY: number, dist: number, beta0: number, invH: number): number {
  const k = dist * dirY * invH;
  const e0 = Math.exp(-Math.min(Math.max(h0, 0) * invH, 80));
  const g = Math.abs(k) < 1e-3 ? 1 - k * (0.5 - k / 6) : (1 - Math.exp(-clamp(k, -80, 80))) / k;
  return beta0 * e0 * dist * g;
}

/** Haze scale height H (m): 400 in fog, 1200 for haze, up to 8000 for very clean air. */
export function hazeScaleHeight(visibilityM: number): number {
  if (visibilityM < 2000) return lerp(300, 400, visibilityM / 2000);
  if (visibilityM < 20_000) return lerp(400, 1200, (visibilityM - 2000) / 18_000);
  return lerp(1200, 8000, clamp((visibilityM - 20_000) / 60_000, 0, 1));
}

/** Three.js r187 ACESFilmicToneMapping (note the `exposure / 0.6` scaling and the AP1 matrices). Output is linear 0..1. */
export function acesFilmic(c: Vec3, exposure: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const k = exposure / 0.6;
  const r = c[0] * k, g = c[1] * k, b = c[2] * k;
  // ACESInputMat (row-major application of the transposed GLSL columns)
  const x = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const y = 0.07600 * r + 0.90834 * g + 0.01566 * b;
  const z = 0.02840 * r + 0.13383 * g + 0.83777 * b;
  const fit = (v: number): number => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  const fx = fit(x), fy = fit(y), fz = fit(z);
  out[0] = clamp(1.60475 * fx - 0.53108 * fy - 0.07367 * fz, 0, 1);
  out[1] = clamp(-0.10208 * fx + 1.10813 * fy - 0.00605 * fz, 0, 1);
  out[2] = clamp(-0.00327 * fx - 0.07276 * fy + 1.07602 * fz, 0, 1);
  return out;
}

/** Linear → sRGB transfer function (one channel). */
export const linearToSrgb = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/**
 * Colour to assign to `scene.fog.color`: Three.js applies `fog_fragment` AFTER tone mapping and
 * output encoding, so the fog colour must already be tone mapped (with the current exposure) and
 * sRGB-encoded to match the sky dome, which tone-maps the same radiance in its own shader.
 */
export function encodeDisplayColor(linear: Vec3, exposure: number, out: Vec3 = [0, 0, 0]): Vec3 {
  acesFilmic(linear, exposure, out);
  out[0] = linearToSrgb(out[0]); out[1] = linearToSrgb(out[1]); out[2] = linearToSrgb(out[2]);
  return out;
}

/** Mix two tuples in place: out = a + (b − a)·t. */
export function mixVec3(a: Vec3, b: Vec3, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

// ── aerial perspective (haze) colour ─────────────────────────────────────────────────────────────

/** Henyey–Greenstein phase function (sr⁻¹, integrates to 1 over the sphere). */
export function hgPhase(cosTheta: number, g: number): number {
  const g2 = g * g;
  return (1 - g2) / (4 * Math.PI * Math.pow(Math.max(1 + g2 - 2 * g * clamp(cosTheta, -1, 1), 1e-6), 1.5));
}

/** Rayleigh phase function (sr⁻¹). */
export const rayleighPhase = (cosTheta: number): number => (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta);

/** Haze aerosol asymmetry (forward-scattering lobe toward the sun). Also used by the GPU lobe (`HAZE_LOBE_GLSL`). */
export const HAZE_G = 0.7;
/** Sea-level Rayleigh extinction at 550 nm, m⁻¹ (molecular share of the Koschmieder β). */
export const RAYLEIGH_BETA_550 = 1.16e-5;

/** Aerosol (Mie) share of the surface extinction for a meteorological visibility (0 … 1). */
export const mieFraction = (visibilityM: number): number => clamp(1 - RAYLEIGH_BETA_550 / fogBetaFromVisibility(visibilityM), 0, 1);

/** Tunables of the haze model (see `hazeColor`). */
export interface HazeOptions {
  /** single-scattering albedo of the haze */ omega: number;
  /** multiple-scattering gain on the single-scattering estimate (optically thick horizontal paths) */ multiScatter: number;
  /** reflectance of the ground under the haze (it lights the haze from below) */ groundAlbedo: number;
  /** the haze never exceeds this fraction of the sky radiance behind it, so the horizon line stays visible */ maxOfSky: number;
}

export const DEFAULT_HAZE: Readonly<HazeOptions> = { omega: 0.9, multiScatter: 2.6, groundAlbedo: 0.15, maxOfSky: 0.8 };

/**
 * Aerial-perspective in-scatter colour L∞ (linear, in three's light units: the radiance scale of a surface
 * lit by the same sun/ambient, albedo/π · irradiance) seen at angle θ from the sun — the colour distant
 * ground fades to. Single scattering of the sun (Rayleigh + Henyey–Greenstein Mie, weighted by the
 * aerosol share of the extinction) plus the sky and ground light scattered isotropically, times a
 * multiple-scattering gain:
 *
 *   L∞ = ω·ms·[ E☉·c☉·P(θ) + (E_sky + ρ_g·E_ground) / 2π ]
 *
 * Unlike the Preetham horizon radiance (≈ 25 × a sunlit field at noon), this sits a little above the lit
 * ground, so 10–20 km ridgelines stay readable through 40 km of visibility. `sunColor` is the hue (max 1),
 * `sunIntensity` the DirectionalLight intensity, `skyIrradiance` the ambient irradiance of an up-facing
 * surface; the result is not yet capped by the sky (see `capBySky`).
 */
export function hazeColor(
  cosTheta: number, sunColor: Vec3, sunIntensity: number, sunElDeg: number, skyIrradiance: Vec3, visibilityM: number,
  out: Vec3 = [0, 0, 0], o: HazeOptions = DEFAULT_HAZE,
): Vec3 {
  const m = mieFraction(visibilityM);
  const phase = m * hgPhase(cosTheta, HAZE_G) + (1 - m) * rayleighPhase(cosTheta);
  const sunI = Math.max(sunIntensity, 0);
  const sinEl = Math.max(Math.sin(sunElDeg * (Math.PI / 180)), 0);
  const k = o.omega * o.multiScatter;
  for (let c = 0; c < 3; c++) {
    const ground = o.groundAlbedo * (sunI * sinEl * sunColor[c] + skyIrradiance[c]);
    out[c] = k * (sunI * sunColor[c] * phase + (skyIrradiance[c] + ground) / (2 * Math.PI));
  }
  return out;
}

/** Limit a haze colour to `maxOfSky` × the sky radiance behind it, per channel (in place). */
export function capBySky(haze: Vec3, sky: Vec3, maxOfSky = DEFAULT_HAZE.maxOfSky): Vec3 {
  for (let c = 0; c < 3; c++) haze[c] = Math.min(haze[c], Math.max(sky[c], 0) * maxOfSky);
  return haze;
}

/**
 * Weight 0…1 of the sun-ward haze colour at angle θ from the sun: the Henyey–Greenstein excess over its
 * value at 90°, normalised at θ = 0. Mixing `fogColor` (θ = 90°) toward `sunGlowColor` (θ = 0) with this
 * reproduces the Mie part of `hazeColor` exactly for θ ≤ 90°. CPU twin of `hazeSunLobe` in `HAZE_LOBE_GLSL`.
 */
export function hazeSunLobe(cosTheta: number, g = HAZE_G): number {
  const p0 = hgPhase(0, g), p1 = hgPhase(1, g);
  return clamp((hgPhase(cosTheta, g) - p0) / (p1 - p0), 0, 1);
}
