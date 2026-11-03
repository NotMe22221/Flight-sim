/**
 * OSM airport pavement albedos for the sky's calibrated light (src/sky/README.md "Calibration"): the apron concrete,
 * taxiway asphalt and yellow lines (vertex colour × the pavement texture) through SkySystem's clear-noon light on a
 * horizontal surface. Targets: concrete ≈ 90–130 and a bit lighter than the asphalt, the asphalt like the runway's
 * (55–90), the yellow a little below white paint. Before: concrete ≈ 174, asphalt ≈ 102, yellow clipping red.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { Vec3 } from '../core/types';
import { sunPosition } from '../geo/solar';
import { encodeDisplayColor } from '../sky/lighting';
import { weatherFromPreset } from '../sky/presets';
import { SkySystem } from '../sky/SkySystem';
import { PAVEMENT_SRGB } from './builder';
import { makePavementImage } from './textures';

const KSFO = { lat: 37.613538, lon: -122.35716 };
const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** as the builder stores them: linear bytes */
const lin8 = (c: number): number => Math.round(lin(c) * 255) / 255;

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

describe('OSM pavement albedos vs the calibrated light', () => {
  const { E, exposure } = noonLight();
  const display = (a: Vec3): Vec3 => encodeDisplayColor([a[0] / Math.PI * E[0], a[1] / Math.PI * E[1], a[2] / Math.PI * E[2]], exposure, [0, 0, 0]).map((v) => v * 255) as Vec3;
  // the pavement texture (sRGB) multiplies the vertex colour: its mean linear value
  const img = makePavementImage(256);
  let tex = 0;
  for (let i = 0; i < img.data.length; i += 4) tex += lin(img.data[i] / 255);
  tex /= img.data.length / 4;

  it('concrete aprons ≈ 90–130 at a clear noon, a bit lighter than the taxiway asphalt (≈ the runway’s 55–90)', () => {
    expect(tex).toBeGreaterThan(0.6);
    expect(tex).toBeLessThan(0.9);
    for (const k of [0, 1]) {
      const v = PAVEMENT_SRGB.concrete + PAVEMENT_SRGB.concreteSpread * k;
      const d = display([lin8(v) * tex, lin8(v * 0.985) * tex, lin8(v * 0.95) * tex]);
      expect(d[1]).toBeGreaterThan(90);
      expect(d[1]).toBeLessThan(130);
    }
    const a = display([lin8(PAVEMENT_SRGB.asphalt) * tex, lin8(PAVEMENT_SRGB.asphalt) * tex, lin8(PAVEMENT_SRGB.asphalt) * tex]);
    expect(a[1]).toBeGreaterThan(55);
    expect(a[1]).toBeLessThan(90);
    const c = display([lin8(PAVEMENT_SRGB.concrete) * tex, lin8(PAVEMENT_SRGB.concrete * 0.985) * tex, lin8(PAVEMENT_SRGB.concrete * 0.95) * tex]);
    expect(c[1] - a[1]).toBeGreaterThan(20);
  });

  it('yellow taxiway lines: a little below white paint, yellow, unclipped', () => {
    const [r, g, b] = PAVEMENT_SRGB.yellow;
    const d = display([lin8(r), lin8(g), lin8(b)]);
    expect(Math.max(...d)).toBeLessThan(234);
    expect(Math.max(...d)).toBeGreaterThan(205);
    expect(d[0]).toBeGreaterThan(d[1]);
    expect(d[1]).toBeGreaterThan(2 * d[2]);
  });
});
