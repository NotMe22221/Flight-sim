/**
 * Dryden continuous turbulence, MIL-F-8785C (docs/research/02 §8.3), discrete real-time
 * form (Yeager 1998 as implemented in JSBSim ttStandard). Deterministic: a serialisable
 * PRNG drives the white noise, drawn once per physics step.
 */
import { Grid2D } from './grid';
import type { TurbulenceIntensity, Vec3 } from '../core/types';
import { FT, KT } from '../core/units';

/**
 * Serializable mulberry32 PRNG with Box–Muller normal deviates. The 32-bit state lives in a
 * Uint32Array: as a plain field, values ≥ 2³¹ were re-boxed as heap numbers on every draw.
 */
export class Rng {
  private readonly s = new Uint32Array(1);
  constructor(state: number) { this.s[0] = state >>> 0; }
  get state(): number { return this.s[0]; }
  set state(v: number) { this.s[0] = v >>> 0; }
  uniform(): number {
    const st = (this.s[0] + 0x6d2b79f5) >>> 0;
    this.s[0] = st;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  normal(): number {
    let u = 0, v = 0;
    while (u === 0) u = this.uniform();
    while (v === 0) v = this.uniform();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

// MIL-F-8785C Fig. 7: σ (ft/s) vs altitude (ft) for probability-of-exceedance indices 1..7
const POE_ALT = [500, 1750, 3750, 7500, 15000, 25000, 35000, 45000, 55000, 65000, 75000, 80000];
// prettier-ignore
const POE_SIGMA = [
  3.2, 2.2, 1.5, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  4.2, 3.6, 3.3, 1.6, 0, 0, 0, 0, 0, 0, 0, 0,
  6.6, 6.9, 7.4, 6.7, 4.6, 2.7, 0.4, 0, 0, 0, 0, 0,
  8.6, 9.6, 10.6, 10.1, 8.0, 6.6, 5.0, 4.2, 2.7, 0, 0, 0,
  11.8, 13.0, 16.0, 15.1, 11.6, 9.7, 8.1, 8.2, 7.9, 4.9, 3.2, 2.1,
  15.6, 17.6, 23.0, 23.6, 22.1, 20.0, 16.0, 15.1, 12.1, 7.9, 6.2, 5.1,
  18.7, 21.5, 28.4, 30.2, 30.7, 31.0, 25.2, 23.1, 17.5, 10.7, 8.4, 7.2,
];
const poe = new Grid2D([1, 2, 3, 4, 5, 6, 7], POE_ALT, POE_SIGMA);

/** Wind speed at 20 ft implied by an intensity index when no explicit W20 is given (kt). */
const W20_BY_INTENSITY = [0, 5, 10, 15, 30, 45, 60, 75];

export interface TurbulenceOutput {
  /** gust velocity NED, m/s */
  velNED: Vec3;
  /** rotational gusts added to the aerodynamic body rates, rad/s */
  pqr: Vec3;
}

export class DrydenTurbulence {
  /** filter states ξu ξv ξw ξp ξq ξr and previous ξv ξw */
  readonly x = new Float64Array(8);
  readonly out: TurbulenceOutput = { velNED: [0, 0, 0], pqr: [0, 0, 0] };
  constructor(public rng: Rng, private readonly span: number) {}

  reset(): void { this.x.fill(0); this.out.velNED.fill(0); this.out.pqr.fill(0); }

  /**
   * Advance one step.
   * @param aglM height above ground
   * @param V airspeed relative to the mean air mass, m/s
   * @param windHeadingRad direction the mean wind blows toward (for along/cross axes)
   * @param bodyHeadingRad aircraft heading, for the rotational components
   */
  step(dt: number, aglM: number, V: number, w20Kt: number, intensity: TurbulenceIntensity, windHeadingRad: number, bodyHeadingRad: number): TurbulenceOutput {
    const o = this.out;
    const w20 = (w20Kt > 0 ? w20Kt : W20_BY_INTENSITY[intensity] ?? 0) * KT / FT; // ft/s
    if (intensity === 0 && w20Kt <= 0) {
      this.x.fill(0); o.velNED.fill(0); o.pqr.fill(0);
      return o;
    }
    const hFt = Math.max(aglM / FT, 10);
    const Vf = Math.max(V / FT, 10); // ft/s
    // low-altitude model (h ≤ 1000 ft)
    const k = 0.177 + 0.000823 * Math.min(hFt, 1000);
    const lwLo = Math.min(hFt, 1000), luLo = Math.min(hFt, 1000) / Math.pow(k, 1.2);
    const swLo = 0.1 * w20, suLo = swLo / Math.pow(k, 0.4);
    // medium/high altitude (h ≥ 2000 ft)
    const sHi = intensity > 0 ? poe.at(intensity, hFt) : 0;
    let Lu: number, Lw: number, su: number, sw: number;
    if (hFt <= 1000) { Lu = luLo; Lw = lwLo; su = suLo; sw = swLo; }
    else if (hFt >= 2000) { Lu = Lw = 1750; su = sw = sHi; }
    else {
      const f = (hFt - 1000) / 1000;
      Lu = luLo + (1750 - luLo) * f; Lw = lwLo + (1750 - lwLo) * f;
      su = suLo + (sHi - suLo) * f; sw = swLo + (sHi - swLo) * f;
    }
    const bf = this.span / FT;
    const T = dt;
    const tu = Lu / Vf, tw = Lw / Vf;
    const x = this.x, r = this.rng;
    // guard the discrete filters (T/τ < 0.5)
    const cu = Math.min(T / tu, 0.5), cw = Math.min(T / tw, 0.5);
    const vPrev = x[1], wPrev = x[2];
    x[0] = (1 - cu) * x[0] + su * Math.sqrt(2 * cu) * r.normal();
    x[1] = (1 - 2 * cu) * x[1] + su * Math.sqrt(4 * cu) * r.normal();
    x[2] = (1 - 2 * cw) * x[2] + sw * Math.sqrt(4 * cw) * r.normal();
    const Lp = Math.sqrt(Lw * bf) / 2.6;
    const sp = (1.9 * sw) / Math.sqrt(Lw * bf);
    const cp = Math.min(T / (Lp / Vf), 0.5);
    x[3] = (1 - cp) * x[3] + sp * Math.sqrt(2 * cp) * r.normal();
    const tq = (4 * bf) / (Math.PI * Vf), tr = (3 * bf) / (Math.PI * Vf);
    x[4] = (1 - Math.min(T / tq, 0.5)) * x[4] + (Math.PI / (4 * bf)) * (x[2] - wPrev);
    x[5] = (1 - Math.min(T / tr, 0.5)) * x[5] + (Math.PI / (3 * bf)) * (x[1] - vPrev);
    // along/cross wind axes → NED (ft/s → m/s); vertical ξw positive down
    const cW = Math.cos(windHeadingRad), sW = Math.sin(windHeadingRad);
    o.velNED[0] = (cW * x[0] - sW * x[1]) * FT;
    o.velNED[1] = (sW * x[0] + cW * x[1]) * FT;
    o.velNED[2] = x[2] * FT;
    const cB = Math.cos(bodyHeadingRad), sB = Math.sin(bodyHeadingRad);
    o.pqr[0] = cB * x[3] + sB * x[4];
    o.pqr[1] = -sB * x[3] + cB * x[4];
    o.pqr[2] = x[5];
    return o;
  }
}
