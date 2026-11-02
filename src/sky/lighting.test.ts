import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../core/types';
import { dirFromAzEl } from '../geo/solar';
import {
  DEFAULT_EXPOSURE, acesFilmic, adaptExposure, ambientFloor, cloudCoverFraction, colorTemperatureK, encodeDisplayColor,
  fogBetaFromVisibility, fogExp2DensityFromVisibility, hazeScaleHeight, hemisphereIntensity, linearToSrgb, moonLightIntensity,
  starVisibility, sunLightIntensity, targetExposure, turbidityFromVisibility,
} from './lighting';
import { DEFAULT_PREETHAM, PreethamSky } from './preetham';

const sunAt = (elDeg: number): PreethamSky => { const s = new PreethamSky(); s.setSun(dirFromAzEl(180, elDeg), DEFAULT_PREETHAM); return s; };

describe('solar-driven lighting curves', () => {
  it('sun colour gets bluer (higher colour temperature) and brighter monotonically with elevation', () => {
    let prevRatio = Infinity, prevLum = -1, prevK = 0;
    for (let el = 0; el <= 90; el += 5) {
      const T = sunAt(el).sunTransmittance();
      const ratio = T[0] / Math.max(T[2], 1e-9); // red / blue
      expect(ratio).toBeLessThanOrEqual(prevRatio + 1e-9);
      prevRatio = ratio;
      const k = colorTemperatureK(T);
      expect(k).toBeGreaterThanOrEqual(prevK - 1);
      prevK = k;
      const I = sunLightIntensity(el, T, 0);
      expect(I).toBeGreaterThanOrEqual(prevLum);
      prevLum = I;
    }
    // horizon sun is red; zenith sun is near-white
    const horizon = sunAt(1).sunTransmittance(), zenith = sunAt(90).sunTransmittance();
    expect(horizon[0] / horizon[2]).toBeGreaterThan(20);
    expect(zenith[0] / zenith[2]).toBeLessThan(1.5);
    expect(colorTemperatureK(zenith)).toBeGreaterThan(4500);
    expect(colorTemperatureK(horizon)).toBeLessThan(3000);
  });

  it('sun intensity is zero below the horizon and reduced under cloud', () => {
    const T: Vec3 = [1, 1, 1];
    expect(sunLightIntensity(-5, T, 0)).toBe(0);
    expect(sunLightIntensity(45, T, 0)).toBeGreaterThan(sunLightIntensity(45, T, 1));
    expect(sunLightIntensity(45, T, 1)).toBeGreaterThan(0);
    expect(sunLightIntensity(45, T, 0)).toBeCloseTo(3, 6);
  });

  it('exposure target is bounded, monotonically decreasing with elevation and adapts smoothly', () => {
    const o = DEFAULT_EXPOSURE;
    let prev = Infinity;
    for (let el = -30; el <= 90; el += 2) {
      const e = targetExposure(el, 0, 1, o);
      expect(e).toBeGreaterThanOrEqual(o.day - 1e-9);
      expect(e).toBeLessThanOrEqual(o.night * 1.15 + 1e-9);
      expect(e).toBeLessThanOrEqual(prev + 1e-9);
      prev = e;
    }
    expect(targetExposure(60, 0, 1)).toBeCloseTo(0.6, 6);
    expect(targetExposure(-30, 0, 1)).toBeCloseTo(1.5, 6);
    expect(targetExposure(-30, 0, 0)).toBeGreaterThan(targetExposure(-30, 0, 1)); // moonless darker → more exposure
    expect(targetExposure(60, 1, 1)).toBeGreaterThan(targetExposure(60, 0, 1)); // overcast
    // adaptation: converges without overshoot
    let e = 0.6;
    for (let i = 0; i < 600; i++) e = adaptExposure(e, 1.5, 1 / 60, 1.5);
    expect(e).toBeCloseTo(1.5, 2);
    expect(adaptExposure(0.6, 1.5, 1 / 60, 1.5)).toBeGreaterThan(0.6);
    expect(adaptExposure(0.6, 1.5, 1 / 60, 1.5)).toBeLessThan(1.5);
  });

  it('hemisphere, ambient floor, moonlight and star visibility have sane ranges', () => {
    expect(hemisphereIntensity(60, 0)).toBeCloseTo(0.9, 6);
    expect(hemisphereIntensity(-20, 0)).toBeCloseTo(0.02, 6);
    expect(hemisphereIntensity(60, 1)).toBeGreaterThan(hemisphereIntensity(60, 0));
    expect(ambientFloor(45, 1, 45)).toBe(0);
    expect(ambientFloor(-30, 0, -10)).toBeCloseTo(0.012, 6);
    expect(ambientFloor(-30, 1, 45)).toBeGreaterThan(ambientFloor(-30, 0, 45));
    expect(moonLightIntensity(45, 1, 0, -30)).toBeGreaterThan(0);
    expect(moonLightIntensity(45, 1, 0, 30)).toBe(0); // daytime
    expect(moonLightIntensity(-10, 1, 0, -30)).toBe(0); // below horizon
    expect(moonLightIntensity(45, 0, 0, -30)).toBe(0); // new moon
    expect(starVisibility(-30, 0)).toBe(1);
    expect(starVisibility(10, 0)).toBe(0);
    expect(starVisibility(-30, 1)).toBe(0);
    expect(starVisibility(-7.5, 0)).toBeCloseTo(0.5, 6);
  });

  it('visibility → turbidity, fog extinction and FogExp2 density (Koschmieder)', () => {
    expect(turbidityFromVisibility(50_000, 0)).toBe(2);
    expect(turbidityFromVisibility(2000, 0)).toBeCloseTo(9.2, 6);
    expect(turbidityFromVisibility(50_000, 1)).toBe(10);
    expect(fogBetaFromVisibility(10_000)).toBeCloseTo(3.912e-4, 9);
    const d = fogExp2DensityFromVisibility(10_000);
    expect(Math.exp(-d * d * 10_000 * 10_000)).toBeCloseTo(0.02, 3);
    expect(hazeScaleHeight(500)).toBeLessThan(hazeScaleHeight(10_000));
    expect(hazeScaleHeight(10_000)).toBeLessThan(hazeScaleHeight(80_000));
    expect(hazeScaleHeight(80_000)).toBeCloseTo(8000, 6);
  });

  it('ACES port: monotonic, saturates, 0 → 0; sRGB encoding', () => {
    expect(acesFilmic([0, 0, 0], 0.6)).toEqual([0, 0, 0]);
    expect(acesFilmic([100, 100, 100], 0.6)[1]).toBeCloseTo(1, 2);
    let prev = 0;
    for (let x = 0; x < 5; x += 0.1) { const v = acesFilmic([x, x, x], 0.6)[1]; expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
    expect(acesFilmic([0.18, 0.18, 0.18], 1.2)[1]).toBeGreaterThan(acesFilmic([0.18, 0.18, 0.18], 0.6)[1]);
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBeCloseTo(1, 9);
    expect(linearToSrgb(0.2140)).toBeCloseTo(0.5, 2);
    const enc = encodeDisplayColor([0.5, 0.5, 0.5], 0.6);
    expect(enc[0]).toBeGreaterThan(0.5);
    expect(enc[0]).toBeLessThan(1);
  });

  it('cloud cover fraction combines layers', () => {
    expect(cloudCoverFraction([])).toBe(0);
    expect(cloudCoverFraction([{ baseM: 0, topM: 1, coverage: 1, density: 1, type: 'stratus' }])).toBe(1);
    expect(cloudCoverFraction([{ baseM: 0, topM: 1, coverage: 0.5, density: 1, type: 'stratus' }, { baseM: 2, topM: 3, coverage: 0.5, density: 1, type: 'stratus' }])).toBeCloseTo(0.75, 9);
  });
});
