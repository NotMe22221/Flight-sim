import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MagVarCache, decimalYear, magneticDeclinationAtYearDeg, magneticDeclinationDeg, magneticField, magneticFieldAtYear } from './magvar';

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

  it('matches every official test value: declination within 0.05°, F within 10 nT', () => {
    for (const r of rows) {
      const m = magneticFieldAtYear(r.lat, r.lon, r.altKm * 1000, r.year);
      expect(Math.abs(m.D - r.decl), `D at ${r.lat},${r.lon}`).toBeLessThan(0.05);
      expect(Math.abs(m.F - r.f), `F at ${r.lat},${r.lon}`).toBeLessThan(10);
    }
  });

  it('matches the X, Y, Z, H components and inclination closely too', () => {
    for (const r of rows) {
      const m = magneticFieldAtYear(r.lat, r.lon, r.altKm * 1000, r.year);
      expect(Math.abs(m.X - r.x)).toBeLessThan(10);
      expect(Math.abs(m.Y - r.y)).toBeLessThan(10);
      expect(Math.abs(m.Z - r.z)).toBeLessThan(10);
      expect(Math.abs(m.H - r.h)).toBeLessThan(10);
      expect(Math.abs(m.I - r.incl)).toBeLessThan(0.05);
    }
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
