/**
 * Extreme inputs must never put NaN/Inf into what the sky hands the GPU (fog, haze, lights, exposure,
 * shared uniforms, built-in height fog): zero / absurd / missing visibility, camera from the ground to
 * 80 km, inside a cloud, day, twilight and night.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { Vec3, WeatherState } from '../core/types';
import { builtinHeightFogValues } from './builtinFog';
import { heightFogOpticalDepth } from './lighting';
import { weatherFromPreset } from './presets';
import { cloudShadowAt, createSkySharedUniforms, type SkySharedUniforms } from './skyUniforms';
import { type SkySnapshot, SkySystem } from './SkySystem';

function stubRenderer(): THREE.WebGLRenderer {
  return {
    toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap }, getPixelRatio: () => 1,
  } as unknown as THREE.WebGLRenderer;
}
const KSFO = { lat: 37.613538, lon: -122.35716 };
const TIMES = { noon: Date.UTC(2025, 5, 21, 20, 0), dusk: Date.UTC(2025, 5, 22, 3, 45), midnight: Date.UTC(2025, 5, 21, 8, 0) };
function snapshot(utcMs: number, weather: WeatherState, heightM: number): SkySnapshot {
  const posNED: Vec3 = [0, 0, -heightM];
  const aircraft = makeAircraftState({ posNED, geo: { ...KSFO, alt: heightM }, altitudeAglM: heightM, altitudeMslM: heightM });
  return { time: { utcMs, timeScale: 1, simTimeS: 0 }, aircraft, weather, frame: { lat0: KSFO.lat, lon0: KSFO.lon, alt0: 0 } };
}

/** Every number reachable from the lighting record / shared uniforms (colours, vectors, scalars). */
function collectNumbers(v: unknown, out: number[] = [], depth = 0): number[] {
  if (depth > 3 || v === null || v === undefined) return out;
  if (typeof v === 'number') { out.push(v); return out; }
  if (v instanceof THREE.Color) { out.push(v.r, v.g, v.b); return out; }
  if (v instanceof THREE.Vector3) { out.push(v.x, v.y, v.z); return out; }
  if (v instanceof THREE.Vector4) { out.push(v.x, v.y, v.z, v.w); return out; }
  if (Array.isArray(v)) { for (const x of v) collectNumbers(x, out, depth + 1); return out; }
  if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) collectNumbers(x, out, depth + 1);
  return out;
}

describe('sky robustness (no NaN/Inf reaches the shaders)', () => {
  const shared: SkySharedUniforms = createSkySharedUniforms();
  const scene = new THREE.Scene();
  const sky = new SkySystem(scene, stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: shared });
  const scattered = weatherFromPreset('scattered', 4);
  const layer = scattered.clouds[0];
  const cases: [string, WeatherState, number][] = [
    ['zero visibility', { ...weatherFromPreset('overcast', 4), visibilityM: 0 }, 2],
    ['ground fog layer, 50 m visibility', { ...weatherFromPreset('overcast', 4), visibilityM: 50, fogTopM: 60 }, 300],
    ['absurd visibility', { ...weatherFromPreset('clear', 4), visibilityM: 1e9 }, 10],
    ['missing visibility (NaN)', { ...weatherFromPreset('few', 4), visibilityM: Number.NaN }, 300],
    ['stratosphere', weatherFromPreset('few', 4), 80_000],
    ['in cloud', scattered, layer ? 0.5 * (layer.baseM + layer.topM) : 1500],
    ['storm, low', weatherFromPreset('storm', 4), 150],
  ];
  for (const [name, wx, h] of cases) {
    for (const [tName, utc] of Object.entries(TIMES)) {
      it(`${name} at ${tName}`, () => {
        const cam = new THREE.Vector3(0, h, 0);
        for (let i = 0; i < 3; i++) sky.update(snapshot(utc + i * 1000, wx, h), cam, 1 / 60);
        const L = sky.lighting;
        const nums = collectNumbers(L);
        expect(nums.length).toBeGreaterThan(30);
        expect(nums.every(Number.isFinite)).toBe(true);
        expect(collectNumbers(shared).every(Number.isFinite)).toBe(true);
        for (const a of [builtinHeightFogValues.a, builtinHeightFogValues.b, builtinHeightFogValues.c]) expect(Array.from(a).every(Number.isFinite)).toBe(true);
        expect(Number.isFinite((scene.fog as THREE.FogExp2).density) && (scene.fog as THREE.FogExp2).density >= 0).toBe(true);
        // the GPU fog formula (same closed form) stays finite looking up, down and level, near and far
        for (const dy of [-1, -0.3, 0, 0.2, 1]) {
          const d = new THREE.Vector3(1, dy, 0.3).normalize();
          for (const dist of [0.5, 100, 2e4, 4e5]) {
            const tau = heightFogOpticalDepth(cam.y - L.groundY, d.y, dist, L.fogDensity, L.fogHeightFalloff);
            expect(Number.isNaN(tau)).toBe(false);
            expect(tau).toBeGreaterThanOrEqual(0);
          }
        }
        const s = cloudShadowAt(shared, 1234, 0, -5678, L.sunDirThree.x, L.sunDirThree.y, L.sunDirThree.z);
        expect(Number.isFinite(s) && s >= 0).toBe(true);
      });
    }
  }
});
