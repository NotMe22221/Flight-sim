/**
 * Regression tests from the adversarial review of the look pass (terrain side).
 */
import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { LocalFrame } from '../geo/wgs84';
import { TERRAIN_SHADERS, WAVE_OMEGAS, WAVE_TIME_PERIOD_S } from './materials';
import { TerrainSystem } from './TerrainSystem';

describe('ocean animation clock (review)', () => {
  it('the shader wave trains are the ones the wrap period was chosen for', () => {
    const found = [...TERRAIN_SHADERS.waterFragment.matchAll(/t \* (\d+\.\d+)\)/g)].map((m) => Number(m[1]));
    expect(found).toEqual([...WAVE_OMEGAS]);
  });

  it('wraps uTime after a whole number of every wave train’s periods (no ripple jump at the wrap)', () => {
    for (const w of WAVE_OMEGAS) {
      const turns = (w * WAVE_TIME_PERIOD_S) / (2 * Math.PI);
      expect(Math.abs(turns - Math.round(turns))).toBeLessThan(1e-9);
    }
    // the old 3600 s wrap moved the 1.1 rad/s train by ≈ 0.25 of a period
    const old = ((1.1 * 3600) / (2 * Math.PI)) % 1;
    expect(Math.min(old, 1 - old)).toBeGreaterThan(0.2);
    // float32 keeps the phase fine just before the wrap (ulp ≈ 0.25 ms)
    expect(WAVE_TIME_PERIOD_S).toBeLessThan(4096);
  });
});

describe('TerrainSystem ocean clock (review)', () => {
  it('wraps at WAVE_TIME_PERIOD_S, not at 3600 s', () => {
    const ts = new TerrainSystem(new LocalFrame(37.613538, -122.35716, 0), {
      fetch: async () => new Response(null, { status: 404 }), minZoom: 12, maxZoom: 13, range0M: 2000,
      horizonCull: false, proceduralTileSize: 16, quadsPerLevel: [8], maxAnisotropy: 1, now: () => 0,
    });
    const cam = new PerspectiveCamera(60, 16 / 9, 0.3, 600_000);
    cam.position.set(0, 100, 0); cam.updateMatrixWorld();
    ts.uniforms.uTime.value = WAVE_TIME_PERIOD_S - 0.1;
    ts.update(cam.position, cam, 0.25);
    expect(ts.uniforms.uTime.value).toBeCloseTo(0.15, 9);
    ts.dispose();
  });
});
