/**
 * Runway albedos for the sky's calibrated light (src/sky/README.md "Calibration"): the asphalt, the markings and
 * the turf rendered through the noon light SkySystem publishes (sun + skylight on a horizontal surface, ACES at the
 * clear-noon exposure), against the measured targets: asphalt 55–90 / 255 and neutral, markings a little below
 * white paint (≈ 215–230, never clipped), turf a mid green. Before: asphalt ≈ 156, markings 239–244 (8 % clipped).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { Vec3 } from '../core/types';
import { sunPosition } from '../geo/solar';
import { encodeDisplayColor } from '../sky/lighting';
import { weatherFromPreset } from '../sky/presets';
import { SkySystem } from '../sky/SkySystem';
import { ASPHALT_SRGB, RUNWAY_MARKING_COLOR, TURF_COLOR } from './AirportsLayer';

const KSFO = { lat: 37.613538, lon: -122.35716 };
const lin = (v: number): number => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const hexLin = (h: number): Vec3 => [lin((h >> 16) & 255), lin((h >> 8) & 255), lin(h & 255)];

/** clear noon at KSFO on 2026-06-21: irradiance on a horizontal surface (sun + skylight) and the exposure */
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
const display = (albedo: Vec3, { E, exposure }: { E: Vec3; exposure: number }): Vec3 =>
  encodeDisplayColor([albedo[0] / Math.PI * E[0], albedo[1] / Math.PI * E[1], albedo[2] / Math.PI * E[2]], exposure, [0, 0, 0]).map((v) => v * 255) as Vec3;

describe('runway albedos vs the calibrated light', () => {
  const light = noonLight();

  it('asphalt: linear ≈ 0.04, sunlit 55–90 / 255 and neutral at a clear noon', () => {
    // the texture is uniform noise over base … base + span (sRGB): mean linear albedo
    let a = 0;
    for (let i = 0; i <= 100; i++) a += lin(ASPHALT_SRGB.base + (ASPHALT_SRGB.span * i) / 100);
    a /= 101;
    expect(a).toBeGreaterThan(0.03);
    expect(a).toBeLessThan(0.055);
    const d = display([a, a, a], light);
    for (const c of d) { expect(c).toBeGreaterThan(55); expect(c).toBeLessThan(90); }
    expect(Math.max(...d) - Math.min(...d)).toBeLessThan(6);
    // even the brightest texels stay well below the markings
    expect(display([lin(ASPHALT_SRGB.base + ASPHALT_SRGB.span), 0, 0], light)[0]).toBeLessThan(110);
  });

  it('markings: a little below white paint (≈ 215–230), unclipped, near-neutral', () => {
    const m = hexLin(RUNWAY_MARKING_COLOR);
    const d = display(m, light);
    for (const c of d) { expect(c).toBeGreaterThan(212); expect(c).toBeLessThan(232); }
    const paint = display([0.85, 0.85, 0.85], light); // the aircraft's white paint
    expect(Math.min(...paint) - Math.max(...d)).toBeGreaterThan(3);
    expect(m[0] / m[2]).toBeLessThan(1.15); // the warm tint of road paint, not yellow
  });

  it('turf: a mid green (G 80–130, R and B lower)', () => {
    const d = display(hexLin(TURF_COLOR), light);
    expect(d[1]).toBeGreaterThan(80);
    expect(d[1]).toBeLessThan(130);
    expect(d[0]).toBeLessThan(d[1]);
    expect(d[2]).toBeLessThan(d[0]);
  });
});
