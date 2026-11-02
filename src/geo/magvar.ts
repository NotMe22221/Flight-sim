/**
 * World Magnetic Model 2025 (WMM2025) — magnetic declination and field vector.
 *
 * Implements the standard NOAA/NCEI algorithm (WMM Technical Report, §1.2–1.4):
 *   1. geodetic (WGS84) → geocentric spherical coordinates (r, φ', λ);
 *   2. Gauss coefficients propagated to the requested decimal year with the linear
 *      secular-variation terms, g(t) = g₀ + (t − 2025.0)·ġ;
 *   3. Schmidt semi-normalised associated Legendre functions P̄ₙᵐ(sin φ') and their
 *      derivatives by recursion (degree/order ≤ 12);
 *   4. spherical-harmonic summation of the field in the geocentric frame;
 *   5. rotation back to the geodetic north/east/down frame by ψ = φ' − φ.
 *
 * Coefficients come from `__fixtures__/wmm2025.json` (public-domain NOAA data) and the
 * implementation is validated against the 20 official WMM2025 test values in
 * `__fixtures__/wmm2025-test-values.csv` (see `magvar.test.ts`).
 *
 * One evaluation costs ~91 coefficient products plus 13 trig pairs (a few µs in V8).
 * `MagVarCache` avoids recomputing every frame: it re-evaluates when the aircraft has moved
 * more than 5 km from the cached position or when 60 s of simulated time have elapsed.
 */
import wmmJson from './__fixtures__/wmm2025.json';

/** Shape of the WMM coefficient file (`geomagnetism` npm layout, index = n(n+1)/2 + m). */
interface WmmCoefficients {
  main_field_coeff_g: number[];
  main_field_coeff_h: number[];
  secular_var_coeff_g: number[];
  secular_var_coeff_h: number[];
  n_max: number;
  n_max_sec_var: number;
  epoch: number;
}

const WMM = wmmJson as WmmCoefficients;

/** Maximum degree/order of the model. */
export const WMM_N_MAX = WMM.n_max;
/** Epoch (decimal year) of the main-field coefficients. */
export const WMM_EPOCH = WMM.epoch;
/** Model validity window (decimal years); results outside it are extrapolated and flagged. */
export const WMM_VALID_FROM = WMM.epoch;
export const WMM_VALID_TO = WMM.epoch + 5;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
/** WGS84 semi-major / semi-minor axes in km (the WMM works in km). */
const A_KM = 6378.137;
const B_KM = 6356.7523142;
const A2 = A_KM * A_KM;
const B2 = B_KM * B_KM;
/** Geomagnetic reference radius, km. */
const RE_KM = 6371.2;
/** metres per degree of latitude (cache staleness check only) */
const M_PER_DEG = 111_195;

const N_COEFF = ((WMM_N_MAX + 1) * (WMM_N_MAX + 2)) / 2; // 91 for n_max = 12

/** index of (n, m) in the flat coefficient arrays */
const idx = (n: number, m: number): number => (n * (n + 1)) / 2 + m;

// ── Schmidt semi-normalisation factors (constant; precomputed once) ─────────────────────
const SCHMIDT = new Float64Array(N_COEFF);
SCHMIDT[0] = 1;
for (let n = 1; n <= WMM_N_MAX; n++) {
  SCHMIDT[idx(n, 0)] = (SCHMIDT[idx(n - 1, 0)] * (2 * n - 1)) / n;
  for (let m = 1; m <= n; m++) {
    SCHMIDT[idx(n, m)] = SCHMIDT[idx(n, m - 1)] * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
  }
}

// ── Scratch buffers (module-level; the evaluation is synchronous and allocation-free) ───
const P = new Float64Array(N_COEFF); // P̄ₙᵐ(sin φ')
const dP = new Float64Array(N_COEFF); // ∂P̄ₙᵐ/∂φ'
const G = new Float64Array(N_COEFF); // time-adjusted g
const H = new Float64Array(N_COEFF); // time-adjusted h
const COS_M = new Float64Array(WMM_N_MAX + 1);
const SIN_M = new Float64Array(WMM_N_MAX + 1);
let coeffYear = NaN; // decimal year the G/H buffers were last filled for

/** Fill the time-adjusted coefficient buffers for `year` (memoised on the year). */
function adjustCoefficients(year: number): void {
  if (year === coeffYear) return;
  const dt = year - WMM_EPOCH;
  const g0 = WMM.main_field_coeff_g, h0 = WMM.main_field_coeff_h;
  const gs = WMM.secular_var_coeff_g, hs = WMM.secular_var_coeff_h;
  for (let i = 0; i < N_COEFF; i++) {
    G[i] = g0[i] + dt * gs[i];
    H[i] = h0[i] + dt * hs[i];
  }
  coeffYear = year;
}

/**
 * Schmidt semi-normalised associated Legendre functions and their latitude derivatives.
 * `x = sin φ'`, `z = cos φ'` (geocentric latitude). Standard WMM `PcupLow` recursion.
 */
function legendre(x: number, z: number): void {
  P[0] = 1;
  dP[0] = 0;
  for (let n = 1; n <= WMM_N_MAX; n++) {
    for (let m = 0; m <= n; m++) {
      const i = idx(n, m);
      if (n === m) {
        const i1 = idx(n - 1, m - 1);
        P[i] = z * P[i1];
        dP[i] = z * dP[i1] + x * P[i1];
      } else if (n === 1 && m === 0) {
        const i1 = idx(n - 1, m);
        P[i] = x * P[i1];
        dP[i] = x * dP[i1] - z * P[i1];
      } else {
        const i2 = idx(n - 1, m);
        if (m > n - 2) {
          P[i] = x * P[i2];
          dP[i] = x * dP[i2] - z * P[i2];
        } else {
          const i1 = idx(n - 2, m);
          const k = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
          P[i] = x * P[i2] - k * P[i1];
          dP[i] = x * dP[i2] - z * P[i2] - k * dP[i1];
        }
      }
    }
  }
  // The recursion above yields ∂P/∂θ (colatitude); flip the sign for ∂P/∂φ' and normalise.
  for (let i = 1; i < N_COEFF; i++) {
    P[i] *= SCHMIDT[i];
    dP[i] = -dP[i] * SCHMIDT[i];
  }
}

/** Geomagnetic field elements. Components in nT, angles in degrees. */
export interface MagneticField {
  /** north component, nT */ X: number;
  /** east component, nT */ Y: number;
  /** down component, nT */ Z: number;
  /** horizontal intensity, nT */ H: number;
  /** total intensity, nT */ F: number;
  /** inclination (dip), deg, positive down */ I: number;
  /** declination (variation), deg, east positive */ D: number;
  /** decimal year the field was evaluated for */ year: number;
  /** false when the requested date is outside the model's 5-year validity window */
  inValidityWindow: boolean;
}

/** Decimal year (e.g. 2026.84) from a UTC epoch in milliseconds. */
export function decimalYear(utcMs: number): number {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (utcMs - start) / (end - start);
}

/**
 * Evaluate the WMM2025 field at a geodetic position and decimal year.
 * @param latDeg geodetic latitude, deg
 * @param lonDeg longitude, deg (east positive)
 * @param altM height above the WGS84 ellipsoid, metres
 * @param year decimal year (use {@link decimalYear} to convert a UTC timestamp)
 * @param out optional object to fill (avoids allocation in loops)
 */
export function magneticFieldAtYear(latDeg: number, lonDeg: number, altM: number, year: number, out?: MagneticField): MagneticField {
  adjustCoefficients(year);

  // 1. geodetic → geocentric spherical
  const phi = latDeg * D2R, lambda = lonDeg * D2R, hKm = altM / 1000;
  const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
  const rc = A2 / Math.sqrt(A2 * cosPhi * cosPhi + B2 * sinPhi * sinPhi); // radius of curvature in the prime vertical (km)
  const p = (rc + hKm) * cosPhi; // distance from the rotation axis
  const zc = ((rc * B2) / A2 + hKm) * sinPhi; // z in ECEF
  const r = Math.sqrt(p * p + zc * zc);
  const sinPhiC = zc / r; // sin of geocentric latitude
  const cosPhiC = Math.sqrt(1 - sinPhiC * sinPhiC);
  const phiC = Math.asin(sinPhiC);

  // 2. Legendre functions at the geocentric latitude
  legendre(sinPhiC, cosPhiC);

  // 3. cos(mλ), sin(mλ)
  for (let m = 0; m <= WMM_N_MAX; m++) {
    COS_M[m] = Math.cos(m * lambda);
    SIN_M[m] = Math.sin(m * lambda);
  }

  // 4. spherical-harmonic summation in the geocentric frame
  const ratio = RE_KM / r;
  let rn = ratio * ratio; // (a/r)^(n+1) for n=1 → start at ratio², multiply each n
  let bx = 0, by = 0, bz = 0;
  for (let n = 1; n <= WMM_N_MAX; n++) {
    rn *= ratio; // (a/r)^(n+2)
    for (let m = 0; m <= n; m++) {
      const i = idx(n, m);
      const gc = G[i] * COS_M[m] + H[i] * SIN_M[m];
      const gs = G[i] * SIN_M[m] - H[i] * COS_M[m];
      bz -= rn * gc * (n + 1) * P[i];
      by += rn * gs * m * P[i];
      bx -= rn * gc * dP[i];
    }
  }
  // Y' = (1/cos φ') Σ…  — at the geographic poles the division is singular; the standard
  // code falls back to a special series. For a flight simulator a tiny clamp is enough.
  by /= Math.max(cosPhiC, 1e-9);

  // 5. rotate from geocentric to geodetic (ψ = φ' − φ)
  const psi = phiC - phi;
  const cosPsi = Math.cos(psi), sinPsi = Math.sin(psi);
  const X = bx * cosPsi - bz * sinPsi;
  const Z = bx * sinPsi + bz * cosPsi;
  const Y = by;

  const Hh = Math.hypot(X, Y);
  const F = Math.hypot(Hh, Z);
  const o = out ?? ({} as MagneticField);
  o.X = X; o.Y = Y; o.Z = Z; o.H = Hh; o.F = F;
  o.I = Math.atan2(Z, Hh) * R2D;
  o.D = Math.atan2(Y, X) * R2D;
  o.year = year;
  o.inValidityWindow = year >= WMM_VALID_FROM && year <= WMM_VALID_TO;
  return o;
}

/**
 * Evaluate the WMM2025 field at a geodetic position and UTC time.
 * @param utcMs UTC epoch milliseconds (the simulated world clock)
 */
export function magneticField(latDeg: number, lonDeg: number, altM: number, utcMs: number, out?: MagneticField): MagneticField {
  return magneticFieldAtYear(latDeg, lonDeg, altM, decimalYear(utcMs), out);
}

/**
 * Magnetic declination (variation) in degrees, east positive, at a geodetic position and UTC time.
 * `true heading = magnetic heading + declination`.
 */
export function magneticDeclinationDeg(latDeg: number, lonDeg: number, altM: number, utcMs: number): number {
  return magneticField(latDeg, lonDeg, altM, utcMs).D;
}

/** Same as {@link magneticDeclinationDeg} but for a decimal year (handy in tests/tools). */
export function magneticDeclinationAtYearDeg(latDeg: number, lonDeg: number, altM: number, year: number): number {
  return magneticFieldAtYear(latDeg, lonDeg, altM, year).D;
}

/**
 * Position/time-keyed cache for the declination of a moving observer (the aircraft).
 * Recomputes when the observer has moved more than `maxDistanceM` from the cached position or
 * when more than `maxAgeMs` of (simulated) time has passed; otherwise returns the cached value.
 * Declination changes by well under 0.05° over 5 km, so the error is negligible for instruments.
 */
export class MagVarCache {
  private lat = NaN;
  private lon = NaN;
  private alt = 0;
  private atMs = -Infinity;
  private value = 0;
  private readonly field: MagneticField = magneticFieldAtYear(0, 0, 0, WMM_EPOCH);
  /** number of model evaluations performed (for tests/diagnostics) */
  evaluations = 0;

  constructor(
    /** recompute when moved further than this, metres (default 5 km) */
    public readonly maxDistanceM = 5000,
    /** recompute when older than this, ms (default 60 s) */
    public readonly maxAgeMs = 60_000,
  ) {}

  /** Declination (deg, east positive) at the position/time, from cache when still fresh. */
  get(latDeg: number, lonDeg: number, altM: number, utcMs: number): number {
    // Flat-earth distance is plenty for a 5 km threshold and keeps this allocation-free.
    const dLatM = (latDeg - this.lat) * M_PER_DEG;
    const dLonM = (lonDeg - this.lon) * M_PER_DEG * Math.cos(latDeg * D2R);
    const stale =
      Number.isNaN(this.lat) ||
      Math.abs(utcMs - this.atMs) > this.maxAgeMs ||
      dLatM * dLatM + dLonM * dLonM > this.maxDistanceM * this.maxDistanceM;
    if (stale) {
      magneticField(latDeg, lonDeg, altM, utcMs, this.field);
      this.value = this.field.D;
      this.lat = latDeg; this.lon = lonDeg; this.alt = altM; this.atMs = utcMs;
      this.evaluations++;
    }
    return this.value;
  }

  /** The full field vector from the most recent evaluation. */
  get lastField(): Readonly<MagneticField> { return this.field; }

  /** Force the next `get` to recompute. */
  invalidate(): void { this.lat = NaN; }
}
