/**
 * Sun vs sky light calibration (look review). The numbers here are targets a photograph with sensible auto
 * exposure would show, checked end to end through SkySystem's published lighting (sun, skylight, exposure)
 * and the ACES/sRGB port, plus physical ratios against the Preetham dome (an independent model):
 * - clear air: direct sun on a horizontal surface ≈ 3–8 × the sky's irradiance at mid sun elevations;
 * - sunlit white paint (albedo 0.85) ≈ 225–245 / 255 and neutral at clear noon; the sky darker than it;
 * - shade lit by the sky alone clearly darker, slightly blue; dusk and night dark but readable;
 * - the exposure follows the light where the camera is (above an overcast deck = clear air).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { Vec3, WeatherState } from '../core/types';
import { sunPosition } from '../geo/solar';
import { encodeDisplayColor, luminance, mieFromVisibility, sunLightIntensity, turbidityFromVisibility } from './lighting';
import { DEFAULT_PREETHAM, PreethamSky } from './preetham';
import { weatherFromPreset } from './presets';
import { type SkySnapshot, SkySystem } from './SkySystem';

function stubRenderer(): THREE.WebGLRenderer {
  return {
    toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap }, getPixelRatio: () => 1,
  } as unknown as THREE.WebGLRenderer;
}
const KSFO = { lat: 37.613538, lon: -122.35716 };
const DAY = Date.UTC(2026, 5, 21);
/** UTC (ms) on DAY when the sun's geometric elevation at KSFO crosses `el` (afternoon), or its maximum ('noon'). */
function timeForElevation(el: number | 'noon'): number {
  let best = DAY, bestEl = -99;
  for (let m = 0; m < 1440; m += 1) { const t = DAY + m * 60_000; const e = sunPosition(t, KSFO.lat, KSFO.lon).elevation; if (e > bestEl) { bestEl = e; best = t; } }
  if (el === 'noon') return best;
  for (let t = best; t < best + 12 * 3_600_000; t += 20_000) if (sunPosition(t, KSFO.lat, KSFO.lon).elevation <= el) return t;
  throw new Error('no crossing');
}
function snapshot(utcMs: number, weather: WeatherState, heightM = 2, agl = heightM): SkySnapshot {
  const posNED: Vec3 = [0, 0, -heightM];
  const aircraft = makeAircraftState({ posNED, geo: { ...KSFO, alt: heightM }, altitudeAglM: agl, altitudeMslM: heightM });
  return { time: { utcMs, timeScale: 1, simTimeS: 0 }, aircraft, weather, frame: { lat0: KSFO.lat, lon0: KSFO.lon, alt0: 0 } };
}
function settled(utcMs: number, weather: WeatherState, heightM = 2): SkySystem {
  const sky = new SkySystem(new THREE.Scene(), stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: null, builtinHeightFog: false });
  sky.update(snapshot(utcMs, weather, heightM), new THREE.Vector3(0, heightM, 0), 1 / 60);
  return sky;
}
/** Displayed sRGB 0–255 of a Lambertian surface (linear albedo) under irradiance E (light units, RGB). */
function display(albedo: number, E: Vec3, exposure: number): Vec3 {
  const lin: Vec3 = [albedo / Math.PI * E[0], albedo / Math.PI * E[1], albedo / Math.PI * E[2]];
  const out = encodeDisplayColor(lin, exposure, [0, 0, 0]);
  return [out[0] * 255, out[1] * 255, out[2] * 255];
}
const spreadPct = (c: Vec3): number => (100 * (Math.max(...c) - Math.min(...c))) / Math.max(...c);
/** Irradiance of an up-facing surface: direct sun + the published skylight (ambientIrradiance). */
function upIrradiance(sky: SkySystem, sunScale = 1): Vec3 {
  const L = sky.lighting;
  const s = L.sunIntensity * sunScale * Math.max(Math.sin((L.sunElevationDeg * Math.PI) / 180), 0);
  return [s * L.sunColor.r + L.ambientIrradiance.r, s * L.sunColor.g + L.ambientIrradiance.g, s * L.sunColor.b + L.ambientIrradiance.b];
}
const sky3 = (L: { ambientIrradiance: THREE.Color }): Vec3 => [L.ambientIrradiance.r, L.ambientIrradiance.g, L.ambientIrradiance.b];

describe('sun vs sky calibration (clear air)', () => {
  it('the direct sun on a horizontal surface is 3–8 × the dome’s skylight from 20° to 76°, growing with the sun', () => {
    const w = weatherFromPreset('clear', 4);
    const params = { ...DEFAULT_PREETHAM, turbidity: turbidityFromVisibility(w.visibilityM, w.aerosol), mieCoefficient: mieFromVisibility(w.visibilityM, w.aerosol) };
    const p = new PreethamSky();
    let prev = 0;
    for (const el of [20, 30, 40, 60, 76]) {
      const r = (el * Math.PI) / 180;
      p.setSun([0, Math.sin(r), -Math.cos(r)], params);
      const T = p.sunTransmittance([0, 0, 0]);
      const sunH = sunLightIntensity(el, T, 0) * (luminance(T) / Math.max(...T)) * Math.sin(r);
      const ratio = sunH / luminance(p.irradianceUp([0, 0, 0]));
      expect(ratio).toBeGreaterThan(2.5);
      expect(ratio).toBeLessThan(8.5);
      expect(ratio).toBeGreaterThan(prev);
      prev = ratio;
    }
  });

  it('SkySystem publishes the dome’s skylight by day: sun/sky on the ground 3–8 × at noon, 2.5–7 × at 40°', () => {
    for (const [el, lo, hi] of [['noon', 3, 8], [40, 2.5, 7]] as const) {
      const sky = settled(timeForElevation(el), weatherFromPreset('clear', 4));
      const L = sky.lighting;
      const sunH = L.sunIntensity * luminance([L.sunColor.r, L.sunColor.g, L.sunColor.b]) * Math.sin((L.sunElevationDeg * Math.PI) / 180);
      const ratio = sunH / luminance(sky3(L));
      expect(ratio).toBeGreaterThan(lo);
      expect(ratio).toBeLessThan(hi);
      sky.dispose();
    }
  });

  it('clear noon: sunlit white paint ≈ 225–245 and neutral, the shade 120–180 and slightly blue, the sky darker than the paint', () => {
    const sky = settled(timeForElevation('noon'), weatherFromPreset('clear', 4));
    const L = sky.lighting;
    const paint = display(0.85, upIrradiance(sky), L.exposure);
    for (const c of paint) { expect(c).toBeGreaterThan(225); expect(c).toBeLessThan(245); }
    expect(spreadPct(paint)).toBeLessThan(6);
    // a wall facing away from the sun: half the sky plus the lit ground (albedo ≈ 0.15) below
    const s = sky3(L), up = upIrradiance(sky);
    const shadeE: Vec3 = [0.5 * s[0] + 0.5 * 0.15 * luminance(up), 0.5 * s[1] + 0.5 * 0.15 * luminance(up), 0.5 * s[2] + 0.5 * 0.15 * luminance(up)];
    const shade = display(0.85, shadeE, L.exposure);
    expect(luminance(shade)).toBeGreaterThan(120);
    expect(luminance(shade)).toBeLessThan(180);
    expect(shade[2]).toBeGreaterThan(shade[0]); // slightly blue …
    expect(shade[2] / shade[0]).toBeLessThan(1.35); // … not sky-blue
    // the clear sky 45° up (away from the sun) is well below the sunlit paint (real: 3–5 × darker in radiance)
    const sky45: Vec3 = [0, 0, 0];
    const r45 = Math.SQRT1_2;
    sky.preetham.radiance([0, r45, r45 * (L.sunDirThree.z > 0 ? -1 : 1)], sky45);
    const paintRad = (0.85 / Math.PI) * luminance(upIrradiance(sky));
    expect(paintRad / luminance(sky45)).toBeGreaterThan(2.5);
    sky.dispose();
  });

  it('golden hour (sun 6°): sun-facing white paint is warm and not clipped, the shade bluish', () => {
    const sky = settled(timeForElevation(6), weatherFromPreset('clear', 4));
    const L = sky.lighting;
    const s = sky3(L);
    // a wall facing the sun: direct sun at ≈ normal incidence, half the sky, the lit ground
    const sunN = L.sunIntensity * Math.cos((L.sunElevationDeg * Math.PI) / 180);
    const g = 0.5 * 0.15 * luminance(upIrradiance(sky));
    const lit = display(0.85, [sunN * L.sunColor.r + 0.5 * s[0] + g, sunN * L.sunColor.g + 0.5 * s[1] + g, sunN * L.sunColor.b + 0.5 * s[2] + g], L.exposure);
    expect(Math.max(...lit)).toBeLessThan(250);
    expect(lit[0]).toBeGreaterThan(lit[2] + 8); // warm
    const shade = display(0.85, [0.5 * s[0] + g, 0.5 * s[1] + g, 0.5 * s[2] + g], L.exposure);
    expect(shade[2]).toBeGreaterThan(shade[0]); // bluish shadows
    expect(luminance(lit)).toBeGreaterThan(luminance(shade) + 40);
    sky.dispose();
  });

  it('civil dusk and night: dark but readable (white paint 50–150 at dusk, a dark field not black at night)', () => {
    const dusk = settled(timeForElevation(-3.5), weatherFromPreset('clear', 4));
    const d = luminance(display(0.85, upIrradiance(dusk), dusk.lighting.exposure));
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(150);
    dusk.dispose();
    const night = settled(timeForElevation(-25), weatherFromPreset('clear', 4));
    const n = luminance(display(0.1, upIrradiance(night), night.lighting.exposure));
    expect(n).toBeGreaterThan(4);
    expect(n).toBeLessThan(40);
    night.dispose();
  });
});

describe('exposure follows the light where the camera is (review)', () => {
  it('above an overcast deck the exposure is the clear-air one; under it the eye opens', () => {
    const noon = timeForElevation('noon');
    const clear = settled(noon, weatherFromPreset('clear', 4), 2500);
    const ovc = weatherFromPreset('overcast', 4); // deck 504–1504 m MSL
    const above = settled(noon, ovc, 2500);
    const below = settled(noon, ovc, 2);
    expect(above.currentExposure / clear.currentExposure).toBeLessThan(1.15);
    expect(below.currentExposure).toBeGreaterThan(above.currentExposure * 1.3);
    for (const s of [clear, above, below]) s.dispose();
  });

  it('inside a cloud the fog is near-neutral grey like the deck it is in, not sky-blue', () => {
    const sky = settled(timeForElevation('noon'), weatherFromPreset('overcast', 4), 1000); // deck 504–1504 m MSL
    expect(sky.lighting.inCloud).toBeGreaterThan(0.5);
    const f = sky.lighting.fogColor;
    expect(spreadPct([f.r, f.g, f.b])).toBeLessThan(20); // the zenith-blue mix measured b/r ≈ 2.1 (spread 53 %)
    expect(f.b).toBeGreaterThanOrEqual(f.r); // still a touch cool, never warm at noon
    sky.dispose();
  });

  it('settles without overshoot after a step and never pumps on a steady scene', () => {
    const noon = timeForElevation('noon');
    const sky = settled(noon, weatherFromPreset('clear', 4));
    const e0 = sky.currentExposure;
    const snap = snapshot(noon, weatherFromPreset('overcast', 4));
    const cam = new THREE.Vector3(0, 2, 0);
    let prev = e0, last = e0;
    for (let i = 0; i < 600; i++) { sky.update(snap, cam, 1 / 60); last = sky.currentExposure; expect(last).toBeGreaterThanOrEqual(prev - 1e-12); prev = last; }
    for (let i = 0; i < 120; i++) { sky.update(snap, cam, 1 / 60); expect(Math.abs(sky.currentExposure - last)).toBeLessThan(1e-3 * last); }
    expect(last).toBeGreaterThan(e0);
    sky.dispose();
  });
});

describe('skylight cost and the environment’s lower hemisphere (review)', () => {
  it('the dome irradiance is integrated when the sun or the air changes, not every frame', () => {
    const noon = timeForElevation('noon');
    const sky = new SkySystem(new THREE.Scene(), stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: null, builtinHeightFog: false });
    let calls = 0;
    const orig = sky.preetham.irradianceUp.bind(sky.preetham);
    sky.preetham.irradianceUp = (out?: Vec3, a?: number, b?: number) => { calls++; return orig(out, a, b); };
    const snap = snapshot(noon, weatherFromPreset('clear', 4));
    const cam = new THREE.Vector3(0, 2, 0);
    for (let i = 0; i < 30; i++) { snap.time.utcMs = noon + i * 16; sky.update(snap, cam, 1 / 60); }
    expect(calls).toBeLessThanOrEqual(1);
    snap.time.utcMs = noon + 3_600_000; // the sun moved ≈ 10°
    sky.update(snap, cam, 1 / 60);
    expect(calls).toBe(2);
    sky.dispose();
  });

  it('the environment bakes the dome desaturated to the skylight’s hue; the dome on screen keeps its colour', () => {
    const sky = settled(timeForElevation('noon'), weatherFromPreset('clear', 4));
    const u = sky.sky.material.uniforms as Record<string, { value: unknown }>;
    expect(sky.sky.material.fragmentShader).toContain('skySaturation');
    expect(u.skySaturation.value).toBe(1);
    let during = NaN;
    (sky as unknown as { pmrem: unknown }).pmrem = {
      fromScene: () => { during = u.skySaturation.value as number; throw new Error('no GPU in Node'); },
      dispose: () => {},
    };
    const warn = console.warn;
    console.warn = () => {};
    try { sky.bakeEnvironment(); } finally { console.warn = warn; }
    expect(during).toBeGreaterThan(0.1); // greyer than the dome …
    expect(during).toBeLessThan(0.6); // … but still a blue sky
    expect(u.skySaturation.value).toBe(1); // restored even when the bake fails
    sky.dispose();
  });

  it('the environment’s lower hemisphere is the lit ground: dark, near neutral, follows the sun', () => {
    const sky = settled(timeForElevation('noon'), weatherFromPreset('clear', 4));
    const g = (sky as unknown as { envGround: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> }).envGround.material.color;
    const ground: Vec3 = [g.r, g.g, g.b];
    const white = (0.85 / Math.PI) * luminance(upIrradiance(sky));
    expect(luminance(ground)).toBeGreaterThan(0.08 * white); // a lit field, not black …
    expect(luminance(ground)).toBeLessThan(0.3 * white); // … and far below white paint (it was default white, 1.0)
    expect(spreadPct(ground)).toBeLessThan(25);
    const noonLum = luminance(ground);
    sky.update(snapshot(timeForElevation(10), weatherFromPreset('clear', 4)), new THREE.Vector3(0, 2, 0), 1 / 60);
    expect(luminance([g.r, g.g, g.b])).toBeLessThan(0.5 * noonLum);
    sky.dispose();
  });
});
