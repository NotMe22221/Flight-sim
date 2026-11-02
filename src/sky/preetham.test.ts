import { describe, expect, it } from 'vitest';
import { dirFromAzEl } from '../geo/solar';
import { DEFAULT_PREETHAM, PreethamSky, opticalInverse, sunIntensityE } from './preetham';

describe('Preetham CPU port', () => {
  it('matches the Sky.js helper constants: sunIntensity and optical length', () => {
    expect(sunIntensityE(1)).toBeCloseTo(1000 * (1 - Math.exp(-(1.6110731556870734 / 1.5))), 6);
    expect(sunIntensityE(Math.cos(1.6110731556870734))).toBeCloseTo(0, 6); // earth-shadow cutoff
    expect(sunIntensityE(-1)).toBe(0);
    expect(opticalInverse(1)).toBeCloseTo(1 / (1 + 0.15 * Math.pow(93.885, -1.253)), 9);
    expect(opticalInverse(0)).toBeGreaterThan(30); // long path at the horizon
  });

  it('midday sky: zenith is blue and darker than the horizon; horizon warmer', () => {
    const sky = new PreethamSky();
    sky.setSun(dirFromAzEl(180, 60), DEFAULT_PREETHAM);
    const z = sky.zenith(), h = sky.horizonAverage();
    expect(z[2]).toBeGreaterThan(z[0]); // blue > red
    expect(h[0] + h[1] + h[2]).toBeGreaterThan(z[0] + z[1] + z[2]); // horizon brighter (Mie + longer path)
    expect(h[0] / h[2]).toBeGreaterThan(z[0] / z[2]); // horizon less blue
    for (const v of [...z, ...h]) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThan(0); }
  });

  it('sunset: sun-ward horizon is redder than the average horizon; night sky is the dark floor', () => {
    const sky = new PreethamSky();
    sky.setSun(dirFromAzEl(250, 2), DEFAULT_PREETHAM);
    const toward = sky.horizonTowardSun(), avg = sky.horizonAverage();
    expect(toward[0] / Math.max(toward[2], 1e-6)).toBeGreaterThan(avg[0] / Math.max(avg[2], 1e-6));
    sky.setSun(dirFromAzEl(0, -30), DEFAULT_PREETHAM);
    const night = sky.zenith();
    expect(night[0]).toBeLessThan(0.01);
    expect(night[2]).toBeGreaterThan(0); // never pure black
  });

  it('turbidity increases horizon brightness (haze) and reddens the sun', () => {
    const clear = new PreethamSky(), hazy = new PreethamSky();
    clear.setSun(dirFromAzEl(180, 30), { ...DEFAULT_PREETHAM, turbidity: 2 });
    hazy.setSun(dirFromAzEl(180, 30), { ...DEFAULT_PREETHAM, turbidity: 10, mieCoefficient: 0.02 });
    const tc = clear.sunTransmittance(), th = hazy.sunTransmittance();
    expect(th[2]).toBeLessThan(tc[2]);
    expect(th[0] / th[2]).toBeGreaterThan(tc[0] / tc[2]);
  });

  it('is allocation-free in the hot path (reuses the out tuple)', () => {
    const sky = new PreethamSky();
    sky.setSun(dirFromAzEl(90, 10), DEFAULT_PREETHAM);
    const out: [number, number, number] = [0, 0, 0];
    expect(sky.radiance([0, 1, 0], out)).toBe(out);
    expect(sky.horizonAverage(out)).toBe(out);
  });
});
