/**
 * Look pass 2 review: the procedural lowland right beside KSFO 28R, rendered through the clear-noon light SkySystem
 * publishes, pixel by pixel (the measured patch is a per-channel median of what is on screen, not the mean albedo
 * of four tiles). Measured in the app after the pass: 112/105/63 — khaki, R above G — because the dry-grass tone
 * and three of the eight field tones were redder than green and the shore sand (the airfield's DEM is 1–4 m) was
 * still the ≈ 0.55-albedo sand of the old, ≈ 4 × too dim light.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { Vec3 } from '../core/types';
import { lonLatToTile, tileToLonLat } from '../geo/mercator';
import { sunPosition } from '../geo/solar';
import { encodeDisplayColor } from '../sky/lighting';
import { weatherFromPreset } from '../sky/presets';
import { SkySystem } from '../sky/SkySystem';
import { ProceduralTerrain } from './procedural';

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
  const s = L.sunIntensity * Math.sin((L.sunElevationDeg * Math.PI) / 180);
  const E: Vec3 = [s * L.sunColor.r + L.ambientIrradiance.r, s * L.sunColor.g + L.ambientIrradiance.g, s * L.sunColor.b + L.ambientIrradiance.b];
  const exposure = L.exposure;
  sky.dispose();
  return { E, exposure };
}

/** Rendered (sRGB 0–255) colours of the procedural imagery within `radiusM` of the 28R threshold, flat ground at `h`. */
function renderedAround(h: number, radiusM: number, light: { E: Vec3; exposure: number }): Vec3[] {
  const p = new ProceduralTerrain();
  const z = 16, w = 128;
  const t = lonLatToTile(KSFO.lon, KSFO.lat, z);
  const out: Vec3[] = [];
  for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1], [1, 0], [0, 1]]) {
    const tx = Math.floor(t.x) + dx, ty = Math.floor(t.y) + dy;
    const rgba = p.imageryTile(new Float32Array(w * w).fill(h), w, z, tx, ty);
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
      const ll = tileToLonLat(tx + (i + 0.5) / w, ty + (j + 0.5) / w, z);
      const dn = (ll.lat - KSFO.lat) * 111_000, de = (ll.lon - KSFO.lon) * 111_000 * Math.cos((KSFO.lat * Math.PI) / 180);
      if (Math.hypot(dn, de) > radiusM) continue;
      const k = (j * w + i) * 4;
      const a = [lin(rgba[k]), lin(rgba[k + 1]), lin(rgba[k + 2])];
      const { E, exposure } = light;
      out.push(encodeDisplayColor([a[0] / Math.PI * E[0], a[1] / Math.PI * E[1], a[2] / Math.PI * E[2]], exposure, [0, 0, 0]).map((v) => v * 255) as Vec3);
    }
  }
  return out;
}
const median = (px: Vec3[]): Vec3 => [0, 1, 2].map((c) => px.map((q) => q[c]).sort((a, b) => a - b)[Math.floor(px.length / 2)]) as Vec3;

describe('procedural ground beside KSFO 28R at a clear noon', () => {
  const light = noonLight();

  it('the airfield lowland reads as a mid green pixel by pixel, not khaki', () => {
    const px = renderedAround(3, 500, light);
    expect(px.length).toBeGreaterThan(5000);
    const greener = px.filter((c) => c[1] > c[0] + 2).length / px.length;
    expect(greener).toBeGreaterThan(0.85); // was 0.59: dry grass and three field tones rendered redder than green
    const m = median(px);
    expect(m[1]).toBeGreaterThan(80);
    expect(m[1]).toBeLessThan(130);
    expect(m[0]).toBeLessThan(m[1] - 8);
    expect(m[2]).toBeLessThan(m[0]);
  });

  it('shore sand is a sand, not a near-white: below the runway markings, wet sand darker', () => {
    const dry = median(renderedAround(1.0, 300, light)); // shore band (0.6–1.8 m) mixed into the grass
    const wet = median(renderedAround(0.1, 300, light)); // wet sand at the waterline
    expect(Math.max(...dry)).toBeLessThan(206); // was ≈ 217 (the markings are ≈ 226, white paint 238)
    expect(Math.max(...wet)).toBeLessThan(175); // was ≈ 194
    expect(Math.max(...dry)).toBeGreaterThan(130);
    expect(dry[0]).toBeGreaterThan(dry[2]); // warm
    expect(Math.max(...wet)).toBeLessThan(Math.max(...dry));
  });
});
