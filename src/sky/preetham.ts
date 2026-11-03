/**
 * CPU port of the Preetham sky model exactly as implemented by the Three.js `Sky` addon
 * (examples/jsm/objects/Sky.js, r187). Produces the same linear, pre-tone-mapping radiance the
 * sky dome shader outputs, so fog, hemisphere light, cloud lighting and the sun colour can be
 * derived from the very same formula and the horizon seam between terrain fog and sky is invisible.
 *
 * No Three.js imports: plain `Vec3` tuples so this file is unit-testable in Node.
 */
import type { Vec3 } from '../core/types';

/** Uniforms of the Three.js `Sky` material that this port mirrors. */
export interface PreethamParams {
  /** 1 (very clear) … 10 (hazy) */ turbidity: number;
  /** 0–4; higher = bluer/darker zenith, redder sunsets */ rayleigh: number;
  /** 0–0.1 haze amount */ mieCoefficient: number;
  /** Mie forward lobe 0.7–0.9 */ mieDirectionalG: number;
}

export const DEFAULT_PREETHAM: Readonly<PreethamParams> = { turbidity: 2.5, rayleigh: 1, mieCoefficient: 0.005, mieDirectionalG: 0.8 };

// Constants copied verbatim from Sky.js so the CPU and GPU evaluations agree.
const TOTAL_RAYLEIGH: Vec3 = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST: Vec3 = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF_ANGLE = 1.6110731556870734; // pi / 1.95
const STEEPNESS = 1.5;
const EE = 1000;
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const THREE_OVER_SIXTEENPI = 0.05968310365946075;
const ONE_OVER_FOURPI = 0.07957747154594767;
/** The shader adds this floor so the night sky is never pure black. */
const NIGHT_FLOOR: Vec3 = [0, 0.0003, 0.00075];
/** Sky.js multiplies the physical radiance by this fixed "exposure" before tone mapping. */
export const SKY_RADIANCE_SCALE = 0.04;

const R2D = 180 / Math.PI;

/**
 * Soft saturation of the in-scattered light (Lin, before the 0.04 scale): Lin · 1 / (1 + lum(Lin) / K).
 * Sky.js's single-scattering horizon is ≈ 16 × the zenith at noon (real clear skies: 2–4 ×), which turned
 * the lower 15° of the dome and every fog/reflection derived from it white; the knee brings the noon
 * horizon to ≈ 3.5 × the zenith, keeps the hue (luminance-based) and leaves the dim zenith and twilight
 * skies almost untouched. `patchSkyDome` applies the same line to the dome shader.
 */
export const INSCATTER_KNEE = 25;

/** Night glow falls off as exp(−sin(elevation) / this) above the horizon (≈ 10° e-folding). */
export const NIGHT_GLOW_SCALE_HEIGHT = 0.18;

/**
 * GLSL for the dome: `skyNightGlow( direction )` with uniforms `nightGlowHorizon` and `nightGlowZenith`
 * (vec3, linear) — the twin of `PreethamSky.setNightGlow`. Composed with the sunlit sky by
 * `skyLitMax` (see {@link TWILIGHT_GLSL}).
 */
export const NIGHT_GLOW_GLSL = /* glsl */ `
uniform vec3 nightGlowHorizon;
uniform vec3 nightGlowZenith;
vec3 skyNightGlow( vec3 dir ) {
  return nightGlowHorizon * exp( - max( dir.y, 0.0 ) / ${NIGHT_GLOW_SCALE_HEIGHT.toFixed(3)} ) + nightGlowZenith;
}
`;

/**
 * Civil / nautical twilight. Sky.js's sun term is cut off once the sun is ≈ 1–2° below the horizon (its
 * `sunIntensity` earth-shadow hack), which left the dome black from ≈ −2° to −6° — darker than the night
 * sky. The twilight term is a deep-blue sky over the whole dome plus a warm band toward the sun's azimuth
 * (falling off with height as exp(−sin el / `TWILIGHT_BAND_SCALE_HEIGHT`) and away from the sun's azimuth),
 * at full strength down to a sun at `TWILIGHT_FULL_DEG` and decaying by e every `TWILIGHT_DECAY_DEG` below.
 * It and the night glow are composed with Sky.js's sunlit in-scatter by a smooth maximum (p = 4, per
 * channel), so the day and golden-hour dome stay Sky.js's own, the twilight takes over as Sky.js fades, and
 * the dome darkens monotonically from the sunset into the night glow (no black gap).
 */
export const TWILIGHT_FULL_DEG = -1;
export const TWILIGHT_DECAY_DEG = 1.6;
export const TWILIGHT_BAND_SCALE_HEIGHT = 0.2;
/** Twilight radiance at full strength (linear, dome scale): the deep-blue dome … */
export const TWILIGHT_ZENITH: Vec3 = [0.004, 0.01, 0.03];
/** … and the warm band at the horizon toward the sun (× azimuth weight × height falloff). */
export const TWILIGHT_BAND: Vec3 = [0.26, 0.13, 0.045];
/** The twilight term and the night glow fade out over these (apparent) sun elevations (deg): none by day. */
export const SKY_EXTRA_DAY_FADE_DEG: readonly [number, number] = [5, 15];

const smooth01 = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 1 at night … 0 by day: the night glow and the twilight term fade out above a ≈ 5–15° sun. */
export function skyExtraDayFade(sunElDeg: number): number {
  return Number.isFinite(sunElDeg) ? 1 - smooth01(SKY_EXTRA_DAY_FADE_DEG[0], SKY_EXTRA_DAY_FADE_DEG[1], sunElDeg) : 1;
}

/** Twilight strength 0…1 for an (apparent) sun elevation: full from −1° up (faded out by day), e-folding every 1.6° below. */
export function twilightStrength(sunElDeg: number): number {
  if (!Number.isFinite(sunElDeg)) return 0;
  return Math.exp(Math.min(sunElDeg - TWILIGHT_FULL_DEG, 0) / TWILIGHT_DECAY_DEG) * skyExtraDayFade(sunElDeg);
}

/** Twilight colours for `PreethamSky.setTwilight` / the dome uniforms at this (apparent) sun elevation. */
export function twilightColors(sunElDeg: number, zenith: Vec3 = [0, 0, 0], band: Vec3 = [0, 0, 0]): { zenith: Vec3; band: Vec3 } {
  const k = twilightStrength(sunElDeg);
  for (let i = 0; i < 3; i++) { zenith[i] = TWILIGHT_ZENITH[i] * k; band[i] = TWILIGHT_BAND[i] * k; }
  return { zenith, band };
}

/** Azimuth weight of the twilight band: 1 toward the sun, ≈ 0.16 at 90°, 0.1 opposite. */
export function twilightAzimuthWeight(dir: Vec3, sunDir: Vec3): number {
  const ls = Math.hypot(sunDir[0], sunDir[2]), ld = Math.hypot(dir[0], dir[2]);
  const c = ls > 1e-4 && ld > 1e-4 ? (sunDir[0] * dir[0] + sunDir[2] * dir[2]) / (ls * ld) : 0;
  const a = 0.5 + 0.5 * c, a2 = a * a;
  return 0.1 + 0.9 * a2 * a2;
}

/** Smooth maximum (p = 4) of two non-negative radiances: the twin of GLSL `skyLitMax`. */
export function skyLitMax(a: number, b: number): number {
  const a2 = Math.max(a, 0) ** 2, b2 = Math.max(b, 0) ** 2;
  return Math.sqrt(Math.sqrt(a2 * a2 + b2 * b2));
}

/**
 * GLSL twin of the twilight term and the composition (uniforms `twilightZenith`, `twilightBand`, vec3 linear):
 * `texColor += skyLitMax( Lin * 0.04, skyNightGlow( dir ) + skyTwilight( dir, sunDir ) ) - Lin * 0.04;`
 */
export const TWILIGHT_GLSL = /* glsl */ `
uniform vec3 twilightZenith;
uniform vec3 twilightBand;
vec3 skyTwilight( vec3 dir, vec3 sunDir ) {
  float ls = length( sunDir.xz ), ld = length( dir.xz );
  float c = ( ls > 1e-4 && ld > 1e-4 ) ? dot( sunDir.xz, dir.xz ) / ( ls * ld ) : 0.0;
  float a = 0.5 + 0.5 * c; a *= a;
  return twilightZenith + twilightBand * ( exp( - max( dir.y, 0.0 ) / ${TWILIGHT_BAND_SCALE_HEIGHT.toFixed(3)} ) * ( 0.1 + 0.9 * a * a ) );
}
vec3 skyLitMax( vec3 a, vec3 b ) {
  vec3 a2 = max( a, vec3( 0.0 ) ); a2 *= a2;
  vec3 b2 = max( b, vec3( 0.0 ) ); b2 *= b2;
  return sqrt( sqrt( a2 * a2 + b2 * b2 ) );
}
`;

/** Sky.js `sunIntensity`: solar irradiance factor with the earth-shadow hack. */
export function sunIntensityE(zenithAngleCos: number): number {
  const c = Math.min(1, Math.max(-1, zenithAngleCos));
  return EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(c)) / STEEPNESS)));
}

/** Sky.js `totalMie(T) * mieCoefficient`. */
export function totalMie(turbidity: number, mieCoefficient: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const c = 0.2 * turbidity * 10e-18;
  const k = 0.434 * c * mieCoefficient;
  out[0] = MIE_CONST[0] * k; out[1] = MIE_CONST[1] * k; out[2] = MIE_CONST[2] * k;
  return out;
}

/** Optical length scale factor for a view direction (Sky.js: `inverse`). `dirY` is the unit direction's up component. */
export function opticalInverse(dirY: number): number {
  const zenithAngle = Math.acos(Math.max(0, Math.min(1, dirY)));
  return 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - zenithAngle * R2D, -1.253));
}

function hgPhase(cosTheta: number, g: number): number {
  const g2 = g * g;
  return ONE_OVER_FOURPI * ((1 - g2) / Math.pow(1 - 2 * g * cosTheta + g2, 1.5));
}

/**
 * Evaluates the Three.js Preetham sky on the CPU. Call `setSun` once per frame, then `radiance`
 * for as many directions as needed (≈ 60 flops each). All outputs are linear RGB in the same
 * scale as the shader (`(Lin + L0) * 0.04 + floor`), i.e. BEFORE tone mapping.
 */
export class PreethamSky {
  readonly betaR: Vec3 = [0, 0, 0];
  readonly betaM: Vec3 = [0, 0, 0];
  readonly sunDir: Vec3 = [0, 1, 0];
  sunE = 0;
  /** night-sky glow at the horizon (airglow + light pollution), linear, added by `patchSkyNightGlow` too */
  readonly nightHorizon: Vec3 = [0, 0, 0];
  /** night-sky glow at the zenith, linear */
  readonly nightZenith: Vec3 = [0, 0, 0];
  /** twilight: deep-blue dome radiance, linear (see `TWILIGHT_GLSL`) */
  readonly twilightZenith: Vec3 = [0, 0, 0];
  /** twilight: warm band at the horizon toward the sun, linear */
  readonly twilightBand: Vec3 = [0, 0, 0];
  private g = 0.8;
  private readonly tmp: Vec3 = [0, 0, 0];
  private readonly tmpLin: Vec3 = [0, 0, 0];

  /**
   * Night glow (see `NIGHT_GLOW_SCALE_HEIGHT`); zeros = the plain Sky.js model. It adds to the dark sky and is
   * composed with the sunlit in-scatter by the smooth maximum `skyLitMax` (it never brightens a day sky).
   */
  setNightGlow(horizon: Vec3, zenith: Vec3): void {
    for (let i = 0; i < 3; i++) { this.nightHorizon[i] = Math.max(horizon[i], 0); this.nightZenith[i] = Math.max(zenith[i], 0); }
  }

  /** Twilight term (see `TWILIGHT_GLSL`, `twilightColors`); zeros = the plain Sky.js model. */
  setTwilight(zenith: Vec3, band: Vec3): void {
    for (let i = 0; i < 3; i++) { this.twilightZenith[i] = Math.max(zenith[i], 0); this.twilightBand[i] = Math.max(band[i], 0); }
  }

  /** `sunDir` must be a unit vector in the render frame (x East, y Up, z South). */
  setSun(sunDir: Vec3, params: PreethamParams): void {
    const l = Math.hypot(sunDir[0], sunDir[1], sunDir[2]) || 1;
    this.sunDir[0] = sunDir[0] / l; this.sunDir[1] = sunDir[1] / l; this.sunDir[2] = sunDir[2] / l;
    this.sunE = sunIntensityE(this.sunDir[1]);
    // vSunfade = 1 − clamp(1 − exp(sunPosition.y / 450000), 0, 1); with a unit sun vector this is ≈ 1.
    const sunfade = 1 - Math.min(1, Math.max(0, 1 - Math.exp(sunDir[1] / 450000)));
    const rayleighCoefficient = params.rayleigh - (1 - sunfade);
    this.betaR[0] = TOTAL_RAYLEIGH[0] * rayleighCoefficient;
    this.betaR[1] = TOTAL_RAYLEIGH[1] * rayleighCoefficient;
    this.betaR[2] = TOTAL_RAYLEIGH[2] * rayleighCoefficient;
    totalMie(params.turbidity, params.mieCoefficient, this.betaM);
    this.g = params.mieDirectionalG;
  }

  /** Extinction factor `Fex` along a unit direction (transmittance of the whole atmosphere). */
  transmittance(dir: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
    const inv = opticalInverse(dir[1]);
    const sR = RAYLEIGH_ZENITH_LENGTH * inv, sM = MIE_ZENITH_LENGTH * inv;
    out[0] = Math.exp(-(this.betaR[0] * sR + this.betaM[0] * sM));
    out[1] = Math.exp(-(this.betaR[1] * sR + this.betaM[1] * sM));
    out[2] = Math.exp(-(this.betaR[2] * sR + this.betaM[2] * sM));
    return out;
  }

  /** Transmittance toward the sun — the colour of direct sunlight at the surface. */
  sunTransmittance(out: Vec3 = [0, 0, 0]): Vec3 {
    return this.transmittance(this.sunDir, out);
  }

  /** Sky radiance (no sun disc) in unit view direction `dir`, linear RGB, pre-tone-mapping. */
  radiance(dir: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
    const Fex = this.transmittance(dir, this.tmp);
    const sd = this.sunDir;
    const cosTheta = dir[0] * sd[0] + dir[1] * sd[1] + dir[2] * sd[2];
    const c = cosTheta * 0.5 + 0.5;
    const rPhase = THREE_OVER_SIXTEENPI * (1 + c * c);
    const mPhase = hgPhase(cosTheta, this.g);
    const sunE = this.sunE;
    const horizonMix = Math.min(1, Math.max(0, Math.pow(1 - sd[1], 5)));
    const glow = Math.exp(-Math.max(dir[1], 0) / NIGHT_GLOW_SCALE_HEIGHT);
    const lin = this.tmpLin;
    for (let i = 0; i < 3; i++) {
      const bR = this.betaR[i], bM = this.betaM[i];
      const ratio = (bR * rPhase + bM * mPhase) / (bR + bM);
      let Lin = Math.pow(Math.max(0, sunE * ratio * (1 - Fex[i])), 1.5);
      const dusk = Math.sqrt(Math.max(0, sunE * ratio * Fex[i]));
      Lin *= 1 + (dusk - 1) * horizonMix; // mix(1, dusk, horizonMix)
      lin[i] = Lin;
    }
    const knee = 1 / (1 + (0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]) / INSCATTER_KNEE);
    const band = Math.exp(-Math.max(dir[1], 0) / TWILIGHT_BAND_SCALE_HEIGHT) * twilightAzimuthWeight(dir, sd);
    for (let i = 0; i < 3; i++) {
      const L0 = 0.1 * Fex[i];
      const extra = this.nightHorizon[i] * glow + this.nightZenith[i] + this.twilightZenith[i] + this.twilightBand[i] * band;
      out[i] = L0 * SKY_RADIANCE_SCALE + NIGHT_FLOOR[i] + skyLitMax(lin[i] * knee * SKY_RADIANCE_SCALE, extra);
    }
    return out;
  }

  /**
   * Radiance averaged over `n` azimuths at elevation `elDeg` (default +1°): the single colour used
   * for `scene.fog` so standard materials fade into the same tint as the sky dome at the horizon.
   */
  horizonAverage(out: Vec3 = [0, 0, 0], n = 8, elDeg = 1): Vec3 {
    const el = elDeg / R2D;
    const ce = Math.cos(el), se = Math.sin(el);
    const dir = this.tmpDir;
    dir[1] = se;
    let r = 0, g = 0, b = 0; // accumulate locally so `out` may alias nothing we read
    for (let i = 0; i < n; i++) {
      const az = (i / n) * 2 * Math.PI;
      dir[0] = ce * Math.sin(az); dir[2] = -ce * Math.cos(az);
      const c = this.radiance(dir, this.tmp2);
      r += c[0]; g += c[1]; b += c[2];
    }
    out[0] = r / n; out[1] = g / n; out[2] = b / n;
    return out;
  }
  private readonly tmp2: Vec3 = [0, 0, 0];
  private readonly tmpDir: Vec3 = [0, 0, 0];

  /** Radiance at the horizon in the sun's azimuth (the warm Mie glow custom fog shaders can add sun-ward). */
  horizonTowardSun(out: Vec3 = [0, 0, 0], elDeg = 1): Vec3 {
    const el = elDeg / R2D;
    const hx = this.sunDir[0], hz = this.sunDir[2];
    const hl = Math.hypot(hx, hz);
    const dir = this.tmpDir;
    // sun at the zenith has no azimuth: any horizon direction will do (north)
    if (hl < 1e-9) { dir[0] = 0; dir[2] = -Math.cos(el); }
    else { dir[0] = (hx / hl) * Math.cos(el); dir[2] = (hz / hl) * Math.cos(el); }
    dir[1] = Math.sin(el);
    return this.radiance(dir, out);
  }

  /**
   * Irradiance of an up-facing surface under the dome, ∫ L cosθ dω over the upper hemisphere (sun disc
   * excluded, as in the environment bake), by stratified cosine-weighted sampling: `nRings` × `nAz`
   * directions of equal weight π / n (512 by default: within 0.5 % of a fine quadrature at noon, 1.5 %
   * at sunset, where the bright horizon band is undersampled). Called once per environment bake.
   */
  irradianceUp(out: Vec3 = [0, 0, 0], nRings = 16, nAz = 32): Vec3 {
    const dir = this.tmpDir;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < nRings; i++) {
      const sinT = Math.sqrt((i + 0.5) / nRings); // cosine-weighted rings: sin²θ uniform
      const cosT = Math.sqrt(Math.max(1 - sinT * sinT, 0));
      for (let j = 0; j < nAz; j++) {
        const az = ((j + 0.5 * (i & 1) + 0.25) / nAz) * 2 * Math.PI;
        dir[0] = sinT * Math.cos(az); dir[1] = cosT; dir[2] = sinT * Math.sin(az);
        const c = this.radiance(dir, this.tmp2);
        r += c[0]; g += c[1]; b += c[2];
      }
    }
    const w = Math.PI / (nRings * nAz);
    out[0] = r * w; out[1] = g * w; out[2] = b * w;
    return out;
  }

  /** Radiance straight up. */
  zenith(out: Vec3 = [0, 0, 0]): Vec3 {
    this.tmp3[0] = 0; this.tmp3[1] = 1; this.tmp3[2] = 0;
    return this.radiance(this.tmp3, out);
  }
  private readonly tmp3: Vec3 = [0, 0, 0];
}
