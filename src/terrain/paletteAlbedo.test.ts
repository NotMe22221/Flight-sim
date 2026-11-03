/**
 * Procedural land-cover albedos for the sky's calibrated light (src/sky/README.md "Calibration"): a lowland around
 * an airport (flat ground at 3 m: field patchwork + grass) rendered through the clear-noon light SkySystem publishes
 * must read as a mid green (G ≈ 80–130 / 255, R and B lower). Before, the ≈ 2.2 × brighter tones read as straw
 * (≈ 182/169/119 measured beside KSFO 28R).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { Vec3 } from '../core/types';
import { lonLatToTile } from '../geo/mercator';
import { sunPosition } from '../geo/solar';
import { encodeDisplayColor } from '../sky/lighting';
import { weatherFromPreset } from '../sky/presets';
import { SkySystem } from '../sky/SkySystem';
import { COL_DRY, COL_GRASS, COL_LUSH, COL_SCRUB, FIELD_TONES, ProceduralTerrain } from './procedural';

const KSFO = { lat: 37.613538, lon: -122.35716 };
const lin = (v: number): number => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };

function noonLight(): { E: Vec3; exposure: number } {
  const day = Date.UTC(2026, 5, 21);
  let t = day, best = -99;
  for (let m = 0; m < 1440; m++) { const u = day + m * 60_000; const e = sunPosition(u, KSFO.lat, KSFO.lon).elevation; if (e > best) { best = e; t = u; } }
  const renderer = { toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, outputColorSpace: THREE.SRGBColorSpace, shadowMap: { enabled: false, type: THREE.PCFShadowMap }, getPixelRatio: () => 1 } as unknown as THREE.WebGLRenderer;
  const sky = new SkySystem(new THREE.Scene(), renderer, { environmentMap: false, stars: 50, sharedUniforms: null, builtinHeightFog: false });
  const aircraft = makeAircraftState({ posNED: [0, 0, -2], geo: { ...KSFO, alt: 2 }, altitudeAglM: 2, altitudeMslM: 2 });
  sky.update({ time: { utcMs: t, timeScale: 1, simTimeS: 0 }, aircraft, weather: weatherFromPreset('clear', 4), frame: { lat0: KSFO.lat, lon0: KSFO.lon, alt0: 0 } }, new THREE.Vector3(0, 2, 0), 1 / 60);
  const L = sky.lighting;
  // the terrain shader: albedo/π · (sun · cos + skylight) on flat ground
  const s = L.sunIntensity * Math.sin((L.sunElevationDeg * Math.PI) / 180);
  const E: Vec3 = [s * L.sunColor.r + L.ambientIrradiance.r, s * L.sunColor.g + L.ambientIrradiance.g, s * L.sunColor.b + L.ambientIrradiance.b];
  const exposure = L.exposure;
  sky.dispose();
  return { E, exposure };
}

describe('procedural land cover vs the calibrated light', () => {
  it('lowland around an airport reads as a mid green at a clear noon', () => {
    const p = new ProceduralTerrain();
    const t = lonLatToTile(KSFO.lon, KSFO.lat, 15);
    const w = 128;
    const acc: Vec3 = [0, 0, 0];
    let n = 0;
    for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [1, 1]]) {
      const rgba = p.imageryTile(new Float32Array(w * w).fill(3), w, 15, Math.floor(t.x) + dx, Math.floor(t.y) + dy);
      for (let k = 0; k < w * w; k++) { for (let c = 0; c < 3; c++) acc[c] += lin(rgba[k * 4 + c]); n++; }
    }
    const albedo = acc.map((v) => v / n) as Vec3;
    expect(albedo[1]).toBeGreaterThan(0.05);
    expect(albedo[1]).toBeLessThan(0.11); // linear green (was ≈ 0.17)
    const { E, exposure } = noonLight();
    const d = encodeDisplayColor([albedo[0] / Math.PI * E[0], albedo[1] / Math.PI * E[1], albedo[2] / Math.PI * E[2]], exposure, [0, 0, 0]).map((v) => v * 255);
    expect(d[1]).toBeGreaterThan(80);
    expect(d[1]).toBeLessThan(130);
    expect(d[0]).toBeLessThan(d[1]);
    expect(d[2]).toBeLessThan(d[0]);
  });

  it('grass and field tones: dark enough for the calibrated sun, greens greener than red, dry tones only a little warm', () => {
    for (const c of [COL_LUSH, COL_GRASS, COL_SCRUB, COL_DRY, ...FIELD_TONES]) {
      expect(Math.max(...c)).toBeLessThanOrEqual(110); // ≈ ≤ 0.16 linear (the old palette reached 168)
      expect(c[2]).toBeLessThan(c[1]); // vegetation: never blue
      expect(c[0] - c[1]).toBeLessThanOrEqual(10); // straw / fallow tones at most slightly warm
    }
    const greens = FIELD_TONES.filter((c) => c[1] > c[0]).length;
    expect(greens).toBeGreaterThanOrEqual(5); // a green patchwork with some stubble and fallow
  });
});
