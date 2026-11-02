import { describe, expect, it } from 'vitest';
import { sunElevationDeg, sunPhase, timeForPreset } from './solar';

describe('solar', () => {
  const KSFO = { lat: 37.62, lon: -122.37 };
  it('sun is up at local noon and down at local midnight in San Francisco', () => {
    const noonUtc = Date.UTC(2026, 5, 21, 20, 0); // 13:00 PDT
    const midnightUtc = Date.UTC(2026, 5, 21, 8, 0);
    expect(sunElevationDeg(noonUtc, KSFO.lat, KSFO.lon)).toBeGreaterThan(70);
    expect(sunElevationDeg(midnightUtc, KSFO.lat, KSFO.lon)).toBeLessThan(-20);
  });
  it('equinox noon elevation ≈ 90 − |lat|', () => {
    const t = Date.UTC(2026, 2, 20, 12, 7); // solar noon near Greenwich, equinox
    expect(sunElevationDeg(t, 51.5, 0)).toBeCloseTo(90 - 51.5, 0);
  });
  it('presets land where expected', () => {
    const day = Date.UTC(2026, 5, 21, 12);
    const dawn = timeForPreset('dawn', day, KSFO.lat, KSFO.lon);
    const noon = timeForPreset('noon', day, KSFO.lat, KSFO.lon);
    const dusk = timeForPreset('dusk', day, KSFO.lat, KSFO.lon);
    const night = timeForPreset('night', day, KSFO.lat, KSFO.lon);
    expect(sunElevationDeg(dawn, KSFO.lat, KSFO.lon)).toBeCloseTo(-1, 0);
    expect(sunElevationDeg(dusk, KSFO.lat, KSFO.lon)).toBeCloseTo(-1, 0);
    expect(dawn).toBeLessThan(noon);
    expect(noon).toBeLessThan(dusk);
    expect(sunElevationDeg(noon, KSFO.lat, KSFO.lon)).toBeGreaterThan(70);
    expect(sunElevationDeg(night, KSFO.lat, KSFO.lon)).toBeLessThan(-25);
    expect(sunPhase(-1)).toBe('civil');
    expect(sunPhase(10)).toBe('day');
    expect(sunPhase(-30)).toBe('night');
  });
});
