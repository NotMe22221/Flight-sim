import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../core/types';
import { dirFromAzEl } from '../geo/solar';
import {
  DAY_ILLUMINANCE, DEFAULT_EXPOSURE, HAZE_G, capBySky, encodeDisplayColor, exposureForIlluminance, hazeColor, hazeSunLobe, hgPhase,
  luminance, mieFraction, rayleighPhase, surfaceIlluminance,
} from './lighting';
import { DEFAULT_PREETHAM, INSCATTER_KNEE, PreethamSky } from './preetham';

const noonSky = (): PreethamSky => { const s = new PreethamSky(); s.setSun(dirFromAzEl(180, 37), { ...DEFAULT_PREETHAM, turbidity: 2.8 }); return s; };

describe('aerial perspective (haze) model', () => {
  it('phase functions integrate to 1 and the sun lobe runs 0 (90°) … 1 (toward the sun)', () => {
    let hg = 0, ray = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const mu = -1 + (2 * (i + 0.5)) / n;
      hg += hgPhase(mu, HAZE_G) * 2 * Math.PI * (2 / n);
      ray += rayleighPhase(mu) * 2 * Math.PI * (2 / n);
    }
    expect(hg).toBeCloseTo(1, 2);
    expect(ray).toBeCloseTo(1, 3);
    expect(hazeSunLobe(1)).toBeCloseTo(1, 9);
    expect(hazeSunLobe(0)).toBe(0);
    expect(hazeSunLobe(-0.7)).toBe(0);
    let prev = 0;
    for (let c = 0; c <= 1.0001; c += 0.05) { const w = hazeSunLobe(Math.min(c, 1)); expect(w).toBeGreaterThanOrEqual(prev - 1e-12); prev = w; }
  });

  it('aerosol share of the extinction grows as the visibility drops', () => {
    expect(mieFraction(200_000)).toBeLessThan(mieFraction(40_000));
    expect(mieFraction(40_000)).toBeLessThan(mieFraction(5_000));
    expect(mieFraction(5_000)).toBeLessThanOrEqual(1);
    expect(mieFraction(1e7)).toBe(0);
  });

  it('noon haze sits between the lit ground and the sky behind it: blue-grey, ridgelines readable', () => {
    const sky = noonSky();
    const horizon: Vec3 = [0, 0, 0];
    sky.horizonAverage(horizon);
    const sun: Vec3 = [1, 0.92, 0.76], amb: Vec3 = [0.4, 0.62, 0.95];
    const haze = capBySky(hazeColor(0, sun, 2.1, 37, amb, 40_000), horizon);
    const E = 2.1 * Math.sin((37 * Math.PI) / 180);
    const ground = luminance([0.12 / Math.PI * (E + amb[0]), 0.12 / Math.PI * (E + amb[1]), 0.12 / Math.PI * (E + amb[2])]);
    expect(luminance(haze)).toBeGreaterThan(1.5 * ground);
    expect(luminance(haze)).toBeLessThan(8 * ground);
    expect(luminance(haze)).toBeLessThan(0.85 * luminance(horizon)); // the horizon line shows
    expect(haze[2]).toBeGreaterThan(haze[0]); // bluish
    // a 20 km ridge (89 % fog at 40 km visibility) still differs from the 60 km background on screen
    const at = (f: number): number => luminance(encodeDisplayColor([ground + (haze[0] - ground) * f, ground + (haze[1] - ground) * f, ground + (haze[2] - ground) * f], 0.6));
    expect(at(0.98) - at(1 - Math.exp(-3.912 * 0.5))).toBeGreaterThan(0.02);
    // sun-ward haze is brighter (Mie forward lobe); no sun → only the sky/ground term remains
    const glow = hazeColor(1, sun, 2.1, 37, amb, 40_000);
    expect(luminance(glow)).toBeGreaterThan(2 * luminance(haze));
    const night = hazeColor(0, sun, 0, -30, [0.1, 0.12, 0.24], 40_000);
    expect(luminance(night)).toBeGreaterThan(0);
    expect(luminance(night)).toBeLessThan(0.1);
  });

  it('capBySky limits each channel to a fraction of the sky radiance', () => {
    const h: Vec3 = [1, 2, 3];
    capBySky(h, [1, 1, 10], 0.5);
    expect(h).toEqual([0.5, 0.5, 3]);
  });

  it('exposure follows the light on the ground: day at midday, bounded by the night value', () => {
    expect(exposureForIlluminance(DAY_ILLUMINANCE, 1)).toBeCloseTo(DEFAULT_EXPOSURE.day, 9);
    expect(exposureForIlluminance(10, 1)).toBe(DEFAULT_EXPOSURE.day);
    expect(exposureForIlluminance(1e-6, 1)).toBeCloseTo(DEFAULT_EXPOSURE.night, 9);
    expect(exposureForIlluminance(1e-6, 0)).toBeGreaterThan(exposureForIlluminance(1e-6, 1));
    let prev = Infinity;
    for (const E of [0.01, 0.1, 0.3, 0.6, 1, 1.8, 3]) { const e = exposureForIlluminance(E, 0.5); expect(e).toBeLessThanOrEqual(prev); prev = e; }
    expect(surfaceIlluminance(2, 30, 0.5)).toBeCloseTo(1.5, 9);
    expect(surfaceIlluminance(2, -5, 0.5)).toBe(0.5);
  });

  it('the in-scatter knee keeps a blue noon horizon ≈ 2–5 × the zenith (Sky.js alone: ≈ 16 ×)', () => {
    const sky = noonSky();
    const z: Vec3 = [0, 0, 0], h: Vec3 = [0, 0, 0];
    sky.zenith(z); sky.horizonAverage(h);
    const ratio = luminance(h) / luminance(z);
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(5);
    expect(h[2]).toBeGreaterThan(h[0]);
    expect(INSCATTER_KNEE).toBeGreaterThan(0);
  });

  it('night glow adds to every direction, more at the horizon', () => {
    const sky = new PreethamSky();
    sky.setSun(dirFromAzEl(180, -30), DEFAULT_PREETHAM);
    const z0: Vec3 = [0, 0, 0], h0: Vec3 = [0, 0, 0];
    sky.zenith(z0); sky.horizonAverage(h0);
    sky.setNightGlow([0.03, 0.02, 0.02], [0.004, 0.005, 0.01]);
    const z1: Vec3 = [0, 0, 0], h1: Vec3 = [0, 0, 0];
    sky.zenith(z1); sky.horizonAverage(h1);
    expect(luminance(h1) - luminance(h0)).toBeGreaterThan(0.015);
    expect(luminance(z1) - luminance(z0)).toBeGreaterThan(0.003);
    expect(luminance(h1)).toBeGreaterThan(luminance(z1));
  });
});
