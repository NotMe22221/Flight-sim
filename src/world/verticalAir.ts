/**
 * Vertical air motion near the ground, added to the weather's (horizontal) wind for the flight model:
 *
 *  - Ridge lift and lee sink: air forced over terrain rises at w = V·∇h (the wind's component up the
 *    slope), taken over ±150 m so single terrain cells do not matter. It is strongest near the slope
 *    and fades with height above the ground (e-folding ~250 m), capped at 6 m/s.
 *  - Thermals: on a sunny, unstable day (`setConvection`), columns of rising air ~150–350 m across,
 *    1–3.5 m/s at their core (× strength), from 60 m above the ground to the convective top (cloud
 *    base), with gentle sink between them. They sit on a 1.6 km grid fixed to the ground (geodetic,
 *    so a floating-origin rebase does not move them), drift with the wind and wax and wane over
 *    10–20 minutes.
 *
 * Positions are in the local NED frame of `setFrame` (north, east, down m from the origin; up = −down).
 */

export interface GroundHeight { (north: number, east: number): number | null }

const R_EARTH = 6_371_000;
const M_PER_DEG = (Math.PI / 180) * R_EARTH;
const D2R = Math.PI / 180;
const CELL_M = 1600;
const SLOPE_DX_M = 150;
const RIDGE_SCALE_M = 250;
const RIDGE_MAX = 6;

const hash = (x: number, y: number, s: number): number => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export class VerticalAir {
  private lat0 = 0;
  private lon0 = 0;
  /** east metres per degree of longitude at a whole-degree reference latitude (fixed across nearby origins) */
  private kLon = M_PER_DEG;
  /** local east metres → reference east metres */
  private kE = 1;
  /** convection strength 0…1 and top of the thermals above the ground (m) */
  private convection = 0;
  private topAglM = 1500;
  private timeS = 0;
  private readonly drift = { n: 0, e: 0 };
  // slope cache: the gradient at the last sample point
  private cacheN = NaN;
  private cacheE = NaN;
  private hn = 0;
  private he = 0;
  private groundUp = 0;

  constructor(private readonly ground: GroundHeight, public enabled = true) {}

  setFrame(lat0: number, lon0: number): void {
    this.lat0 = lat0; this.lon0 = lon0;
    const ref = Math.round(lat0);
    this.kLon = M_PER_DEG * Math.cos(ref * D2R);
    this.kE = Math.cos(ref * D2R) / Math.max(1e-6, Math.cos(lat0 * D2R));
    this.cacheN = NaN;
  }

  /** Thermal strength 0 (none) … 1 (a strong summer afternoon) and the convective top above the ground, m. */
  setConvection(strength: number, topAglM: number): void {
    this.convection = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
    this.topAglM = Number.isFinite(topAglM) ? Math.max(200, topAglM) : 1500;
  }

  /** Advance the thermals' life cycle and drift (wind in m/s, NED). */
  update(dtS: number, windN: number, windE: number): void {
    if (!(dtS > 0)) return;
    this.timeS += dtS;
    this.drift.n += (Number.isFinite(windN) ? windN : 0) * dtS;
    this.drift.e += (Number.isFinite(windE) ? windE : 0) * dtS;
  }

  /** Terrain slope (dh/dn, dh/de) and ground height under a point (cached within 30 m). */
  private slope(n: number, e: number): boolean {
    if (Number.isFinite(this.cacheN) && Math.abs(n - this.cacheN) < 30 && Math.abs(e - this.cacheE) < 30) return true;
    const g = this.ground, d = SLOPE_DX_M;
    const h0 = g(n, e), hN = g(n + d, e), hS = g(n - d, e), hE = g(n, e + d), hW = g(n, e - d);
    if (h0 === null || hN === null || hS === null || hE === null || hW === null) { this.cacheN = NaN; return false; }
    this.hn = (hN - hS) / (2 * d); this.he = (hE - hW) / (2 * d);
    this.groundUp = h0;
    this.cacheN = n; this.cacheE = e;
    return true;
  }

  /**
   * Vertical air velocity (m/s, + up) at a local-NED point, for a horizontal wind (m/s, NED) there.
   */
  upwardMs(n: number, e: number, down: number, windN: number, windE: number): number {
    if (!this.enabled || !this.slope(n, e)) return 0;
    const agl = -down - this.groundUp;
    if (agl < 0) return 0;
    let w = 0;
    // ridge lift / lee sink
    const ridge = (windN * this.hn + windE * this.he) * Math.exp(-agl / RIDGE_SCALE_M);
    w += Math.max(-RIDGE_MAX, Math.min(RIDGE_MAX, ridge));
    // thermals
    if (this.convection > 0) w += this.thermal(n, e, agl) * this.convection;
    return w;
  }

  /** Thermal updraft (m/s at full convection) at a point `agl` metres above the ground. */
  thermal(n: number, e: number, agl: number): number {
    if (agl < 0 || agl > this.topAglM) return 0;
    // ground-fixed coordinates (m north / east of 0°, 0° at this latitude's scale), shifted by the drift
    const N = (this.lat0 * M_PER_DEG + n) - this.drift.n;
    const E = (this.lon0 * this.kLon + e * this.kE) - this.drift.e;
    const ci = Math.floor(N / CELL_M), cj = Math.floor(E / CELL_M);
    // vertical profile: builds from 60 m, full by ~25 % of the top, weakens in the top 20 %
    const zf = Math.min(1, Math.max(0, (agl - 60) / Math.max(1, 0.25 * this.topAglM - 60))) * Math.min(1, (this.topAglM - agl) / (0.2 * this.topAglM));
    let best = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const i = ci + di, j = cj + dj;
      if (hash(i, j, 1) > 0.6) continue; // ~60 % of cells have a thermal
      const cN = (i + 0.2 + 0.6 * hash(i, j, 2)) * CELL_M, cE = (j + 0.2 + 0.6 * hash(i, j, 3)) * CELL_M;
      const r = 150 + 200 * hash(i, j, 4);
      const period = 600 + 600 * hash(i, j, 5);
      const life = 0.5 + 0.5 * Math.sin((2 * Math.PI * this.timeS) / period + 6.283 * hash(i, j, 6));
      const core = (1 + 2.5 * hash(i, j, 7)) * life;
      const d2 = ((N - cN) ** 2 + (E - cE) ** 2) / (r * r);
      if (d2 < 9) best = Math.max(best, core * Math.exp(-d2));
    }
    // between thermals the air sinks gently (continuity)
    return (best - 0.35) * zf;
  }
}
