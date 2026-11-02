/**
 * Wind field: layered mean wind with a logarithmic surface profile, vector interpolation between
 * layers and MIL-F-8785C "1 − cosine" discrete gusts with a seeded stochastic trigger.
 *
 * Conventions: `WindLayer.directionDeg` is the direction the wind blows FROM (meteorological);
 * all vectors returned here are wind VELOCITY in NED (the direction the air moves TOWARD), m/s.
 * Continuous turbulence (Dryden) lives in the FDM; this file only provides mean wind + gusts.
 */
import { clamp, lerp, mulberry32 } from '../core/math';
import type { Vec3, WindLayer } from '../core/types';
import { KT } from '../core/units';

const D2R = Math.PI / 180;

/** Aerodynamic roughness length (m) for grass/airfield terrain. */
export const Z0_DEFAULT = 0.03;
/** Reference height (m) of the surface wind observation (METAR anemometer). */
export const WIND_REFERENCE_HEIGHT_M = 10;
/** Cap on the log-profile multiplier applied above the reference height when no layer aloft exists. */
export const LOG_PROFILE_MAX = 1.3;

/** Horizontal wind velocity NED from a meteorological FROM direction (deg true) and speed (m/s). */
export function windVectorNED(directionFromDeg: number, speedMs: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const toward = (directionFromDeg + 180) * D2R;
  out[0] = Math.cos(toward) * speedMs;
  out[1] = Math.sin(toward) * speedMs;
  out[2] = 0;
  return out;
}

/** Logarithmic wind profile multiplier relative to the 10 m reference, capped at `LOG_PROFILE_MAX`. */
export function logProfileFactor(aglM: number, z0 = Z0_DEFAULT): number {
  const h = Math.max(aglM, z0 * 1.01);
  const f = Math.log(h / z0) / Math.log(WIND_REFERENCE_HEIGHT_M / z0);
  return clamp(f, 0, LOG_PROFILE_MAX);
}

/** Index of the layer at or below `altMslM` (layers must be sorted by altM ascending). */
function lowerIndex(layers: readonly WindLayer[], altMslM: number): number {
  let i = 0;
  while (i < layers.length - 1 && layers[i + 1].altM <= altMslM) i++;
  return i;
}

/**
 * Mean wind velocity (NED, m/s) at an altitude. Below the lowest layer the surface log profile is
 * applied using `aglM`; between layers the N/E components are interpolated linearly (so direction
 * wraps correctly); above the top layer the top layer is held.
 */
export function windAt(layers: readonly WindLayer[], altMslM: number, aglM: number, out: Vec3 = [0, 0, 0], z0 = Z0_DEFAULT): Vec3 {
  if (layers.length === 0) { out[0] = out[1] = out[2] = 0; return out; }
  const first = layers[0];
  if (layers.length === 1 || altMslM <= first.altM) {
    windVectorNED(first.directionDeg, first.speedKt * KT, out);
    const f = logProfileFactor(aglM, z0);
    out[0] *= f; out[1] *= f;
    return out;
  }
  const i = lowerIndex(layers, altMslM);
  const a = layers[i], b = layers[Math.min(i + 1, layers.length - 1)];
  const t = a === b || b.altM === a.altM ? 0 : clamp((altMslM - a.altM) / (b.altM - a.altM), 0, 1);
  const va = windVectorNED(a.directionDeg, a.speedKt * KT, scratchA);
  const vb = windVectorNED(b.directionDeg, b.speedKt * KT, scratchB);
  out[0] = lerp(va[0], vb[0], t); out[1] = lerp(va[1], vb[1], t); out[2] = 0;
  return out;
}
const scratchA: Vec3 = [0, 0, 0];
const scratchB: Vec3 = [0, 0, 0];

/** Gust excess over the mean (m/s) at an altitude: interpolated `(gustKt − speedKt)`, never negative. */
export function gustExcessAt(layers: readonly WindLayer[], altMslM: number): number {
  if (layers.length === 0) return 0;
  const ex = (l: WindLayer) => Math.max(0, (l.gustKt - l.speedKt) * KT);
  if (layers.length === 1 || altMslM <= layers[0].altM) return ex(layers[0]);
  const i = lowerIndex(layers, altMslM);
  const a = layers[i], b = layers[Math.min(i + 1, layers.length - 1)];
  const t = a === b || b.altM === a.altM ? 0 : clamp((altMslM - a.altM) / (b.altM - a.altM), 0, 1);
  return lerp(ex(a), ex(b), t);
}

/** Unit 1 − cosine gust envelope: 0 → 1 → 0 over `x ∈ [0, 2·rampM]` (peak at `x = rampM`), 0 outside. */
export function gustEnvelope(x: number, rampM: number): number {
  if (x <= 0 || x >= 2 * rampM) return 0;
  return 0.5 * (1 - Math.cos((Math.PI * x) / rampM));
}

export interface GustModelOptions {
  /** mean time between gusts when gusts are reported, s */ meanIntervalS: number;
  /** refractory period after a gust, s */ minIntervalS: number;
  /** ramp length range (MIL-F-8785C d_m 30–120 m) */ rampMinM: number; rampMaxM: number;
  /** gust magnitude as a fraction of the reported excess, range */ magMin: number; magMax: number;
}

export const DEFAULT_GUST_OPTIONS: Readonly<GustModelOptions> = { meanIntervalS: 40, minIntervalS: 12, rampMinM: 30, rampMaxM: 120, magMin: 0.5, magMax: 1.0 };

/**
 * Discrete gust generator. Each gust is a MIL-F-8785C 1 − cosine bump along the mean-wind
 * direction with magnitude up to the reported gust excess; the aircraft "flies through" it so the
 * envelope advances by the relative air speed. Deterministic for a given seed and call sequence.
 */
export class GustModel {
  private readonly rnd: () => number;
  private readonly o: GustModelOptions;
  /** distance travelled into the current gust, m; < 0 when idle */
  private x = -1;
  private rampM = 60;
  private magnitude = 0;
  private sinceLastS = Infinity;
  /** current gust velocity along the mean wind, m/s */
  private speed = 0;
  private readonly dir: Vec3 = [1, 0, 0];

  constructor(seed = 1, options: Partial<GustModelOptions> = {}) {
    this.rnd = mulberry32(seed);
    this.o = { ...DEFAULT_GUST_OPTIONS, ...options };
  }

  /** 0..1 envelope of the active gust (0 when idle). */
  get envelope(): number { return this.magnitude > 0 ? this.speed / this.magnitude : 0; }
  /** true while a gust is passing */
  get active(): boolean { return this.x >= 0; }

  /** Force a gust to start now (used by tests and UI). */
  trigger(excessMs: number): void {
    const o = this.o;
    this.rampM = lerp(o.rampMinM, o.rampMaxM, this.rnd());
    this.magnitude = excessMs * lerp(o.magMin, o.magMax, this.rnd());
    this.x = 0;
    this.sinceLastS = 0;
  }

  /**
   * Advance the model.
   * @param dt step, s
   * @param relativeSpeedMs speed at which the aircraft meets the gust (≈ TAS, at least the wind speed)
   * @param excessMs reported gust excess over the mean at the aircraft altitude, m/s (0 disables triggering)
   * @param meanWindNED mean wind velocity; the gust acts along its direction
   */
  update(dt: number, relativeSpeedMs: number, excessMs: number, meanWindNED: Vec3): void {
    const len = Math.hypot(meanWindNED[0], meanWindNED[1]);
    if (len > 1e-3) { this.dir[0] = meanWindNED[0] / len; this.dir[1] = meanWindNED[1] / len; }
    this.sinceLastS += dt;
    if (this.x >= 0) {
      this.x += Math.max(relativeSpeedMs, 3) * dt;
      if (this.x >= 2 * this.rampM) { this.x = -1; this.speed = 0; }
      else this.speed = this.magnitude * gustEnvelope(this.x, this.rampM);
      return;
    }
    this.speed = 0;
    if (excessMs > 0.1 && this.sinceLastS >= this.o.minIntervalS) {
      // Poisson trigger with the configured mean interval
      if (this.rnd() < dt / this.o.meanIntervalS) this.trigger(excessMs);
    }
  }

  /** Current gust velocity (NED, m/s), zero when idle. */
  gustNED(out: Vec3 = [0, 0, 0]): Vec3 {
    out[0] = this.dir[0] * this.speed; out[1] = this.dir[1] * this.speed; out[2] = 0;
    return out;
  }
}
