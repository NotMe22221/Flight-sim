/**
 * Review of look pass 2, measured in the real app (KSFO 28R, 2026-06-21, the look-calibration harness) and
 * locked here on the CPU twin:
 * - civil dusk: the twilight term turned the zenith/horizon samples deep blue, and the twilight skylight curve
 *   (`hemisphereIntensity` × that hue normalised to max channel 1) lost ≈ 36 % of its luminance with it: at a
 *   −3.5° sun white paint went 106 → 72 / 255, the runway asphalt 22 → 2 (black) and the grass 54 → 9; the
 *   calibration had accepted dusk as it was. The curve keeps its calibrated luminance through civil dusk now
 *   (bluish, monotonic), golden hour and the night unchanged.
 * - the dome's smooth maximum raised dusk radiances (≈ 1e-3) to the 4th power: ≈ 1e-12, which underflows at
 *   mediump precision (the twilight would vanish on such GPUs); it is max · (1 + (min/max)⁴)^¼ now.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { Vec3, WeatherState } from '../core/types';
import { sunPosition } from '../geo/solar';
import { luminance } from './lighting';
import { TWILIGHT_GLSL, skyLitMax } from './preetham';
import { weatherFromPreset } from './presets';
import { type SkySnapshot, SkySystem } from './SkySystem';
import { createSkySharedUniforms } from './skyUniforms';

function stubRenderer(): THREE.WebGLRenderer {
  return {
    toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap }, getPixelRatio: () => 1,
  } as unknown as THREE.WebGLRenderer;
}
const KSFO = { lat: 37.613538, lon: -122.35716 };
const DAY = Date.UTC(2026, 5, 21);
let noonCache = 0;
/** UTC (ms) on DAY when the sun's geometric elevation at KSFO crosses `el` in the afternoon, or its maximum ('noon'). */
function timeForElevation(el: number | 'noon'): number {
  if (!noonCache) {
    let best = DAY, bestEl = -99;
    for (let m = 0; m < 1440; m += 1) { const t = DAY + m * 60_000; const e = sunPosition(t, KSFO.lat, KSFO.lon).elevation; if (e > bestEl) { bestEl = e; best = t; } }
    noonCache = best;
  }
  if (el === 'noon') return noonCache;
  for (let t = noonCache; t < noonCache + 12 * 3_600_000; t += 5_000) if (sunPosition(t, KSFO.lat, KSFO.lon).elevation <= el) return t;
  throw new Error('no crossing');
}
function snapshot(utcMs: number, weather: WeatherState, heightM = 2): SkySnapshot {
  const aircraft = makeAircraftState({ posNED: [0, 0, -heightM], geo: { ...KSFO, alt: heightM }, altitudeAglM: heightM, altitudeMslM: heightM });
  return { time: { utcMs, timeScale: 1, simTimeS: 0 }, aircraft, weather, frame: { lat0: KSFO.lat, lon0: KSFO.lon, alt0: 0 } };
}
function makeSky(): SkySystem {
  return new SkySystem(new THREE.Scene(), stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: createSkySharedUniforms(), builtinHeightFog: false });
}
const ambient = (sky: SkySystem): Vec3 => { const a = sky.lighting.ambientIrradiance; return [a.r, a.g, a.b]; };

describe('look pass 2 review: civil-dusk skylight', () => {
  const clear = weatherFromPreset('clear', 4);

  it('keeps the calibrated dusk level, darkens monotonically from golden hour into the night, golden hour and night unchanged', () => {
    const sky = makeSky();
    const cam = new THREE.Vector3(0, 2, 0);
    const lumAt = (el: number): number => { sky.update(snapshot(timeForElevation(el), clear), cam, 1 / 60); return luminance(ambient(sky)); };
    // golden hour (6°) and the night (−25°): as calibrated (luminance of the skylight incl. the night floor)
    expect(lumAt(6)).toBeCloseTo(0.478, 2);
    expect(lumAt(-25)).toBeCloseTo(0.192, 2);
    // civil dusk: the calibrated light was 0.39 at −2° and 0.335 at −3.5° (Sky.js's neutral floor as the hue);
    // with the deep-blue twilight dome it had fallen to 0.23 / 0.22 — night level
    expect(lumAt(-2)).toBeGreaterThan(0.31);
    expect(lumAt(-3.5)).toBeGreaterThan(0.3);
    expect(lumAt(-3.5)).toBeLessThan(0.4);
    // still bluish (the twilight sky), never warmer than neutral
    const a = ambient(sky);
    expect(a[2] / a[0]).toBeGreaterThan(1.3);
    expect(a[2] / a[0]).toBeLessThan(2.6);
    // monotonic: no bump (the pre-twilight dome had one: 0.31 at 0°, 0.39 at −2°) and no step
    let prev = Infinity;
    for (let el = 8; el >= -16; el -= 0.5) {
      const l = lumAt(el);
      expect(l, `skylight brightens from ${el + 0.5}° to ${el}°`).toBeLessThanOrEqual(prev * 1.002);
      if (prev < Infinity) expect(prev / l, `step at ${el}°`).toBeLessThan(1.12);
      prev = l;
    }
    sky.dispose();
  });
});

describe('look pass 2 review: smooth maximum precision', () => {
  it('is exact for dusk-size radiances and the dome shader never forms their 4th powers', () => {
    expect(skyLitMax(1e-6, 0)).toBeCloseTo(1e-6, 15);
    expect(skyLitMax(0, 3e-5)).toBeCloseTo(3e-5, 15);
    expect(skyLitMax(2e-4, 2e-4) / 2e-4).toBeCloseTo(2 ** 0.25, 9);
    expect(skyLitMax(0.3, 0.1)).toBeCloseTo((0.3 ** 4 + 0.1 ** 4) ** 0.25, 12);
    expect(TWILIGHT_GLSL).toContain('min( x, y ) / max( m, vec3( 1e-20 ) )');
    expect(TWILIGHT_GLSL).not.toMatch(/a2 \* a2|b2 \* b2/);
  });
});
