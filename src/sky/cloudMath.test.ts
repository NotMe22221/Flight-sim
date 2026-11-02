import { describe, expect, it } from 'vitest';
import type { CloudLayer } from '../core/types';
import { CLOUD_NOISE_GLSL, cloudDensityAt, cloudLayerDensityAt, coverageMask, fbm2, hash2, valueNoise2, verticalProfile } from './cloudMath';

const layer = (o: Partial<CloudLayer> = {}): CloudLayer => ({ baseM: 1000, topM: 1800, coverage: 0.5, density: 1, type: 'cumulus', ...o });

describe('cloud density maths', () => {
  it('hash / noise / fbm are deterministic and in 0..1', () => {
    expect(hash2(3, 4)).toBe(hash2(3, 4));
    expect(hash2(3, 4)).not.toBe(hash2(4, 3));
    let min = 1, max = 0, sum = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const v = fbm2(i * 0.37, i * 0.11);
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1);
      min = Math.min(min, v); max = Math.max(max, v); sum += v;
    }
    expect(max - min).toBeGreaterThan(0.4); // has contrast
    expect(sum / n).toBeGreaterThan(0.35); expect(sum / n).toBeLessThan(0.65); // centred
    expect(valueNoise2(2, 7)).toBeCloseTo(hash2(2, 7), 9); // lattice points return the hash
  });

  it('coverage mask: 0 ⇒ 0 everywhere, 1 ⇒ 1 everywhere, in between monotonic', () => {
    for (const s of [0, 0.2, 0.5, 0.8, 1]) { expect(coverageMask(s, 0)).toBe(0); expect(coverageMask(s, 1)).toBe(1); }
    let prev = -1;
    for (let c = 0; c <= 1; c += 0.05) { const m = coverageMask(0.5, c); expect(m).toBeGreaterThanOrEqual(prev); prev = m; }
  });

  it('vertical profile is 1 in the body, feathered at the edges, 0 outside', () => {
    const l = layer();
    expect(verticalProfile(l, 999)).toBe(0);
    expect(verticalProfile(l, 1801)).toBe(0);
    expect(verticalProfile(l, 1400)).toBe(1);
    expect(verticalProfile(l, 1010)).toBeGreaterThan(0); expect(verticalProfile(l, 1010)).toBeLessThan(1);
  });

  it('cloudDensityAt: inside the layer > 0 (somewhere), outside = 0, coverage 1 ⇒ ≈ density', () => {
    const half = layer({ coverage: 0.5 });
    expect(cloudDensityAt([half], 500, 500, 500)).toBe(0);
    expect(cloudDensityAt([half], 500, 2500, 500)).toBe(0);
    let hits = 0, total = 0;
    for (let x = 0; x < 50_000; x += 500) for (let z = 0; z < 50_000; z += 500) { total++; if (cloudDensityAt([half], x, 1400, z) > 0) hits++; }
    expect(hits / total).toBeGreaterThan(0.3); expect(hits / total).toBeLessThan(0.9);
    const full = layer({ coverage: 1, density: 0.8 });
    for (let x = 0; x < 20_000; x += 1234) expect(cloudDensityAt([full], x, 1400, x * 0.3)).toBeCloseTo(0.8, 9);
    expect(cloudDensityAt([layer({ coverage: 1, density: 1.5 })], 0, 1400, 0)).toBe(1); // clamped
    expect(cloudDensityAt([layer({ coverage: 0 })], 0, 1400, 0)).toBe(0);
    expect(cloudDensityAt([], 0, 1400, 0)).toBe(0);
  });

  it('wind drift moves the field; multiple layers take the max', () => {
    const l = layer({ coverage: 0.5 });
    let differs = false;
    for (let x = 0; x < 20_000 && !differs; x += 700) differs = cloudLayerDensityAt(l, x, 1400, 0, 0, 0) !== cloudLayerDensityAt(l, x, 1400, 0, 3000, 0);
    expect(differs).toBe(true);
    expect(cloudLayerDensityAt(l, 5000, 1400, 0, 3000, 0)).toBeCloseTo(cloudLayerDensityAt(l, 2000, 1400, 0, 0, 0), 9);
    const a = layer({ coverage: 1, density: 0.3 }), b = layer({ baseM: 1200, topM: 1600, coverage: 1, density: 0.9, type: 'stratus' });
    expect(cloudDensityAt([a, b], 0, 1400, 0)).toBeCloseTo(0.9, 9);
  });

  it('exports the GLSL twin with the same softness constant', () => {
    expect(CLOUD_NOISE_GLSL).toContain('cloudFbm');
    expect(CLOUD_NOISE_GLSL).toContain('0.250');
    expect(CLOUD_NOISE_GLSL).toContain('CLOUD_OCTAVES');
  });
});
