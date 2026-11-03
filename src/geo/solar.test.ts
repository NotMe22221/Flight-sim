import { describe, expect, it } from 'vitest';
import { dirFromAzEl, moonPosition, sunPosition } from './solar';

describe('solar', () => {
  it('London summer solstice noon: elevation ≈ 62°, azimuth ≈ 180°', () => {
    // 2025-06-21 ~12:01 UTC is solar noon at lon 0 (EoT ≈ -1.7 min)
    const s = sunPosition(Date.UTC(2025, 5, 21, 12, 2), 51.5, 0);
    expect(s.elevation).toBeGreaterThan(61.5);
    expect(s.elevation).toBeLessThan(62.5);
    expect(Math.abs(s.azimuth - 180)).toBeLessThan(2);
    expect(s.declination).toBeCloseTo(23.44, 1);
  });

  it('equinox at KSFO: noon elevation ≈ 90 − lat, sunrise azimuth ≈ 90°', () => {
    // local solar noon at lon -122.37 ≈ 12:00 + 8h09m UTC (+ EoT ≈ −7.5 min on Mar 20) ≈ 20:17 UTC
    const noon = sunPosition(Date.UTC(2025, 2, 20, 20, 17), 37.62, -122.37);
    expect(noon.elevation).toBeCloseTo(90 - 37.62, 0);
    expect(Math.abs(noon.azimuth - 180)).toBeLessThan(3);
    // sunrise ≈ 6 h before solar noon
    const rise = sunPosition(Date.UTC(2025, 2, 20, 14, 17), 37.62, -122.37);
    expect(Math.abs(rise.elevation)).toBeLessThan(2.5);
    expect(Math.abs(rise.azimuth - 90)).toBeLessThan(3);
  });

  it('midnight sun is below the horizon at KSFO and refraction lifts the apparent disc', () => {
    const s = sunPosition(Date.UTC(2025, 5, 21, 8, 0), 37.62, -122.37); // ~1 am local
    expect(s.elevation).toBeLessThan(-20);
    const h = sunPosition(Date.UTC(2025, 2, 20, 14, 17), 37.62, -122.37);
    expect(h.apparentElevation).toBeGreaterThan(h.elevation);
  });

  it('direction vector convention: sun in the east at the horizon → +x; south → −z; zenith → +y', () => {
    expect(dirFromAzEl(90, 0)[0]).toBeCloseTo(1, 10);
    expect(dirFromAzEl(180, 0)[2]).toBeCloseTo(1, 10); // z = South positive
    expect(dirFromAzEl(0, 0)[2]).toBeCloseTo(-1, 10);
    expect(dirFromAzEl(123, 90)[1]).toBeCloseTo(1, 10);
  });

  it('moon position is sane: elevation within ±90, phase in [0,1], full moon ~0.5', () => {
    // 2025-01-13 22:27 UTC was a full moon
    const m = moonPosition(Date.UTC(2025, 0, 13, 22, 27), 37.62, -122.37);
    expect(Math.abs(m.elevation)).toBeLessThanOrEqual(90);
    expect(m.phase).toBeGreaterThan(0.45);
    expect(m.phase).toBeLessThan(0.55);
    expect(m.illuminatedFraction).toBeGreaterThan(0.97);
    // 2025-01-29 12:36 UTC new moon
    const n = moonPosition(Date.UTC(2025, 0, 29, 12, 36), 37.62, -122.37);
    expect(n.illuminatedFraction).toBeLessThan(0.03);
  });
});

import { sunEvents } from './solar';
describe('sun events', () => {
  it('San Francisco, 3 Nov 2026: sunrise ≈ 14:40 UTC, sunset ≈ 01:05 UTC (+1 day)', () => {
    const e = sunEvents(Date.UTC(2026, 10, 3, 20, 0), 37.62, -122.37);
    const rise = new Date(e.sunriseMs), set = new Date(e.sunsetMs);
    expect(rise.getUTCHours() * 60 + rise.getUTCMinutes()).toBeGreaterThan(14 * 60 + 25);
    expect(rise.getUTCHours() * 60 + rise.getUTCMinutes()).toBeLessThan(14 * 60 + 55);
    const setMin = ((set.getUTCHours() + 24) % 24) * 60 + set.getUTCMinutes();
    expect(setMin).toBeGreaterThan(0 * 60 + 50);
    expect(setMin).toBeLessThan(1 * 60 + 20);
    expect(e.noonMs).toBeGreaterThan(e.sunriseMs);
    expect(e.sunsetMs).toBeGreaterThan(e.noonMs);
  });
  it('events sit at the standard geometric altitude −0.833° (refraction + semi-diameter, not double-counted)', () => {
    for (const [lat, lon, t] of [[37.62, -122.37, Date.UTC(2026, 10, 3, 20)], [47.26, 11.34, Date.UTC(2026, 5, 21, 12)], [-33.95, 151.18, Date.UTC(2026, 0, 10, 2)]] as const) {
      const e = sunEvents(t, lat, lon);
      expect(sunPosition(e.sunriseMs, lat, lon).elevation).toBeCloseTo(-0.833, 2);
      expect(sunPosition(e.sunsetMs, lat, lon).elevation).toBeCloseTo(-0.833, 2);
    }
  });
  it('polar night returns NaN events', () => {
    const e = sunEvents(Date.UTC(2026, 11, 21, 12), 80, 0);
    expect(Number.isNaN(e.sunriseMs)).toBe(true);
  });
});
