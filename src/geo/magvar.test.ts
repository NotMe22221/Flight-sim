import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MagVarCache, decimalYear, geodeticToGeocentric, magneticDeclinationAtYearDeg, magneticDeclinationDeg, magneticField, magneticFieldAtYear, schmidtLegendre } from './magvar';
import { geodeticToEcef } from './wgs84';

interface TestRow { year: number; altKm: number; lat: number; lon: number; x: number; y: number; z: number; h: number; f: number; incl: number; decl: number }

function loadTestValues(): TestRow[] {
  const csv = readFileSync(join(__dirname, '__fixtures__', 'wmm2025-test-values.csv'), 'utf8');
  const lines = csv.trim().split(/\r?\n/).slice(1);
  return lines.map((line) => {
    const [year, alt, lat, lon, x, y, z, h, f, incl, decl] = line.split(',').map(Number);
    return { year, altKm: alt, lat, lon, x, y, z, h, f, incl, decl };
  });
}

describe('magvar (WMM2025)', () => {
  const rows = loadTestValues();

  it('loads the 20 official test values', () => {
    expect(rows).toHaveLength(20);
  });

  // The official values carry X/Y/Z/H/F to 1e-6 nT and D/I rounded to 0.01°, so a correct
  // implementation reproduces the components to ~1e-3 nT and the angles to the rounding (0.005°).
  // These tolerances are what make a wrong Schmidt factor, a skipped geocentric rotation or a
  // missing secular-variation term fail (each of those is tens to hundreds of nT).
  it('matches every official test value: declination/inclination to the published rounding', () => {
    for (const r of rows) {
      const m = magneticFieldAtYear(r.lat, r.lon, r.altKm * 1000, r.year);
      expect(Math.abs(m.D - r.decl), `D at ${r.lat},${r.lon}`).toBeLessThan(0.0051);
      expect(Math.abs(m.I - r.incl), `I at ${r.lat},${r.lon}`).toBeLessThan(0.0051);
    }
  });

  it('matches the X, Y, Z, H, F components to 0.01 nT', () => {
    for (const r of rows) {
      const m = magneticFieldAtYear(r.lat, r.lon, r.altKm * 1000, r.year);
      expect(Math.abs(m.X - r.x), `X at ${r.lat},${r.lon}`).toBeLessThan(0.01);
      expect(Math.abs(m.Y - r.y), `Y at ${r.lat},${r.lon}`).toBeLessThan(0.01);
      expect(Math.abs(m.Z - r.z), `Z at ${r.lat},${r.lon}`).toBeLessThan(0.01);
      expect(Math.abs(m.H - r.h), `H at ${r.lat},${r.lon}`).toBeLessThan(0.01);
      expect(Math.abs(m.F - r.f), `F at ${r.lat},${r.lon}`).toBeLessThan(0.01);
    }
  });

  it('secular variation: the 2025.5 official rows need it, and the field is linear in time', () => {
    for (const r of rows.filter((x) => x.year === 2025.5)) {
      // Evaluated at the epoch (no secular change) every 2025.5 row misses by > 5 nT …
      const m0 = magneticFieldAtYear(r.lat, r.lon, r.altKm * 1000, 2025.0);
      expect(Math.max(Math.abs(m0.X - r.x), Math.abs(m0.Y - r.y), Math.abs(m0.Z - r.z))).toBeGreaterThan(5);
    }
    // … and g(t) = g0 + (t − 2025)·ġ makes X/Y/Z exactly linear in t.
    const a = { ...magneticFieldAtYear(37.62, -122.37, 0, 2025) };
    const b = { ...magneticFieldAtYear(37.62, -122.37, 0, 2026.5) };
    const c = { ...magneticFieldAtYear(37.62, -122.37, 0, 2028) };
    for (const k of ['X', 'Y', 'Z'] as const) expect(c[k] - a[k]).toBeCloseTo(2 * (b[k] - a[k]), 6);
    // KSFO declination drifts west by ≈ 0.09°/yr (NOAA calculator: ~5′ W per year for SF)
    expect(b.D - a.D).toBeLessThan(-0.1);
    expect(b.D - a.D).toBeGreaterThan(-0.17);
  });

  it('Schmidt semi-normalised Legendre functions match closed forms and their normalisation', () => {
    const lat = 0.6; // rad (geocentric)
    const x = Math.sin(lat), z = Math.cos(lat);
    const closed: [number, number, number][] = [
      [1, 0, x], [1, 1, z],
      [2, 0, (3 * x * x - 1) / 2], [2, 1, Math.sqrt(3) * x * z], [2, 2, (Math.sqrt(3) / 2) * z * z],
      [3, 0, (5 * x ** 3 - 3 * x) / 2], [3, 3, (Math.sqrt(10) / 4) * z ** 3],
    ];
    for (const [n, m, v] of closed) expect(schmidtLegendre(n, m, lat).p, `P${n}${m}`).toBeCloseTo(v, 12);
    // ∫ P̄ₙᵐ(x)² dx over [−1, 1] = 2(2 − δₘ₀)/(2n + 1) for every n, m ≤ 12 (Simpson on φ, dx = cos φ dφ)
    const N = 2000, h = Math.PI / N;
    for (let n = 1; n <= 12; n++) {
      for (let m = 0; m <= n; m++) {
        let sum = 0;
        for (let i = 0; i <= N; i++) {
          const phi = -Math.PI / 2 + i * h;
          const w = i === 0 || i === N ? 1 : i % 2 ? 4 : 2;
          sum += w * schmidtLegendre(n, m, phi).p ** 2 * Math.cos(phi);
        }
        const integral = (sum * h) / 3;
        expect(integral, `norm P${n}${m}`).toBeCloseTo((2 * (m === 0 ? 1 : 2)) / (2 * n + 1), 6);
      }
    }
    // dP̄/dφ' is the latitude derivative (central difference)
    for (const [n, m] of [[1, 0], [2, 1], [5, 3], [12, 7], [12, 12]] as const) {
      const e = 1e-6;
      const fd = (schmidtLegendre(n, m, lat + e).p - schmidtLegendre(n, m, lat - e).p) / (2 * e);
      expect(schmidtLegendre(n, m, lat).dp, `dP${n}${m}`).toBeCloseTo(fd, 6);
    }
    expect(() => schmidtLegendre(3, 4, 0)).toThrow(RangeError);
  });

  it('geodetic → geocentric conversion agrees with the WGS84 ECEF transform', () => {
    // equator: r = a; poles: r = b; 45°: φ' = atan((b/a)² tan φ) = 44.8076°
    expect(geodeticToGeocentric(0, 0).rKm).toBeCloseTo(6378.137, 9);
    expect(geodeticToGeocentric(90, 0).rKm).toBeCloseTo(6356.7523142, 6);
    expect(geodeticToGeocentric(45, 0).latRad).toBeCloseTo(Math.atan((6356.7523142 / 6378.137) ** 2), 12); // 44.807577°
    for (const [lat, h] of [[45, 0], [37.6, 4], [-33.9, 10_000], [80, 28_000], [-89.9, 3000]]) {
      const g = geodeticToGeocentric(lat, h);
      const [x, y, zz] = geodeticToEcef(lat, 0, h);
      const r = Math.hypot(x, y, zz) / 1000;
      expect(g.rKm, `r at ${lat}`).toBeCloseTo(r, 6);
      // (the WMM's b = 6356.7523142 km is rounded vs. a·(1 − f); that alone is ~1e-11 rad)
      expect(g.latRad, `φ' at ${lat}`).toBeCloseTo(Math.atan2(zz, Math.hypot(x, y)), 10);
      expect(g.sinLat ** 2 + g.cosLat ** 2).toBeCloseTo(1, 14);
    }
  });

  it('stays finite at and near the geographic poles', () => {
    for (const lat of [90, -90, 89.9999999, -89.9999]) {
      for (const lon of [0, 77, -150]) {
        const m = magneticFieldAtYear(lat, lon, 0, 2026);
        for (const v of [m.X, m.Y, m.Z, m.H, m.F, m.I, m.D]) expect(Number.isFinite(v), `${lat},${lon}`).toBe(true);
        expect(m.F).toBeGreaterThan(50_000);
      }
    }
  });

  it('reproduces the spec’s 2026-11-02 declinations (docs/research/05 §4.2) to 0.02°', () => {
    const y = decimalYear(Date.UTC(2026, 10, 2));
    const cases: [string, number, number, number, number][] = [
      ['KSFO', 37.6188, -122.375, 4, 12.79], ['KSEA', 47.4502, -122.3088, 132, 14.83], ['KTRK', 39.32, -120.1396, 1802, 12.74],
      ['KASE', 39.2232, -106.869, 2381, 8.37], ['LOWI', 47.2602, 11.344, 581, 4.26], ['EGLL', 51.4706, -0.461941, 25, 1.11],
      ['YSSY', -33.9461, 151.177, 6, 12.85],
    ];
    for (const [id, lat, lon, alt, decl] of cases) expect(Math.abs(magneticDeclinationAtYearDeg(lat, lon, alt, y) - decl), id).toBeLessThan(0.02);
  });

  it('KSFO declination is ≈ 13.0° E in 2026', () => {
    const d = magneticDeclinationAtYearDeg(37.6199, -122.3748, 4, 2026.84);
    expect(d).toBeGreaterThan(12.5);
    expect(d).toBeLessThan(13.5);
  });

  it('Innsbruck declination is ≈ 4° E in 2026', () => {
    const d = magneticDeclinationAtYearDeg(47.2602, 11.344, 581, 2026.84);
    expect(d).toBeGreaterThan(3);
    expect(d).toBeLessThan(5);
  });

  it('decimalYear converts UTC timestamps', () => {
    expect(decimalYear(Date.UTC(2025, 0, 1))).toBeCloseTo(2025.0, 9);
    expect(decimalYear(Date.UTC(2025, 6, 2, 12))).toBeCloseTo(2025.5, 2);
    expect(decimalYear(Date.UTC(2026, 10, 2))).toBeCloseTo(2026.84, 2);
  });

  it('UTC-ms entry points agree with the decimal-year ones', () => {
    const t = Date.UTC(2026, 10, 2);
    const a = magneticDeclinationDeg(37.62, -122.37, 4, t);
    const b = magneticDeclinationAtYearDeg(37.62, -122.37, 4, decimalYear(t));
    expect(a).toBeCloseTo(b, 12);
    const f = magneticField(37.62, -122.37, 4, t);
    expect(f.D).toBeCloseTo(a, 12);
    expect(f.inValidityWindow).toBe(true);
    expect(magneticField(37.62, -122.37, 4, Date.UTC(2031, 0, 1)).inValidityWindow).toBe(false);
  });

  it('is fast (well under 50 µs per evaluation)', () => {
    const out = magneticFieldAtYear(0, 0, 0, 2026);
    const N = 20000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) magneticFieldAtYear(37 + (i % 100) * 0.01, -122 + (i % 37) * 0.01, 1000, 2026.5, out);
    const perCallUs = ((performance.now() - t0) / N) * 1000;
    expect(perCallUs).toBeLessThan(50);
  });

  it('MagVarCache recomputes only when moved > 5 km or after 60 s', () => {
    const c = new MagVarCache();
    const t0 = Date.UTC(2026, 10, 2);
    const d0 = c.get(37.62, -122.37, 100, t0);
    expect(c.evaluations).toBe(1);
    // 1 km east, 10 s later → cached
    expect(c.get(37.62, -122.359, 100, t0 + 10_000)).toBe(d0);
    expect(c.evaluations).toBe(1);
    // 6 km north → recompute
    c.get(37.674, -122.37, 100, t0 + 20_000);
    expect(c.evaluations).toBe(2);
    // same place, 61 s later → recompute
    c.get(37.674, -122.37, 100, t0 + 20_000 + 61_000);
    expect(c.evaluations).toBe(3);
    c.invalidate();
    c.get(37.674, -122.37, 100, t0 + 20_000 + 61_000);
    expect(c.evaluations).toBe(4);
    expect(c.lastField.D).toBeCloseTo(d0, 0);
  });
});
