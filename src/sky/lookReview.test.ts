/**
 * Regression tests from the adversarial review of the look pass (sky side): cloud shadows along the
 * sun ray only, frame-rate independence, no per-frame allocations in the cloud parameters.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { CloudLayer, Vec3, WeatherState } from '../core/types';
import { cloudTypeParams } from './cloudMath';
import { weatherFromPreset } from './presets';
import { SKY_UNIFORMS_GLSL, cloudShadowAt, createSkySharedUniforms, type SkySharedUniforms } from './skyUniforms';
import { type SkySnapshot, SkySystem } from './SkySystem';

function stubRenderer(): THREE.WebGLRenderer {
  return {
    toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap }, getPixelRatio: () => 1,
  } as unknown as THREE.WebGLRenderer;
}
const KSFO = { lat: 37.613538, lon: -122.35716 };
const NOON = Date.UTC(2025, 5, 21, 20, 0);
function snapshot(utcMs: number, weather: WeatherState, heightM: number): SkySnapshot {
  const posNED: Vec3 = [0, 0, -heightM];
  const aircraft = makeAircraftState({ posNED, geo: { ...KSFO, alt: heightM }, altitudeAglM: heightM, altitudeMslM: heightM });
  return { time: { utcMs, timeScale: 1, simTimeS: 0 }, aircraft, weather, frame: { lat0: KSFO.lat, lon0: KSFO.lon, alt0: 0 } };
}

/** One fully covering, optically thick layer whose middle is at `midY` (render y). */
function solidDeck(midY: number): SkySharedUniforms {
  const u = createSkySharedUniforms();
  u.uCloudShadowCount.value = 1;
  u.uCloudShadowA.value[0].set(1, 1 / 2500, 0, 30); // coverage 1 ⇒ density 1 everywhere
  u.uCloudShadowB.value[0].set(midY, 0, 0, 0);
  u.uCloudShadowStrength.value = 1;
  u.uCloudShadowFloor.value = 0.15;
  u.uCloudShadowNorm.value = 1;
  return u;
}

describe('cloud shadows follow the sun ray (review)', () => {
  const sun = new THREE.Vector3(0.3, 0.8, -0.4).normalize();

  it('a deck above the point shadows it', () => {
    const u = solidDeck(1500);
    expect(cloudShadowAt(u, 100, 0, -200, sun.x, sun.y, sun.z)).toBeCloseTo(0.15, 6);
  });

  it('a deck BELOW the point does not shadow it (aircraft or peaks on top of the clouds)', () => {
    const u = solidDeck(1500);
    // the sun ray from 3000 m goes up, away from the deck at 1500 m
    expect(cloudShadowAt(u, 100, 3000, -200, sun.x, sun.y, sun.z)).toBeCloseTo(1, 6);
    // between two decks only the upper one counts
    u.uCloudShadowCount.value = 2;
    u.uCloudShadowA.value[1].set(1, 1 / 6000, 0, 0.5); // thin upper deck: tr = exp(−0.5 / sy)
    u.uCloudShadowB.value[1].set(8000, 0, 0, 0);
    const between = cloudShadowAt(u, 100, 3000, -200, sun.x, sun.y, sun.z);
    expect(between).toBeCloseTo(Math.exp(-0.5 / sun.y), 6);
  });

  it('the GLSL twin carries the same above/below guard', () => {
    expect(SKY_UNIFORMS_GLSL).toMatch(/step\(\s*worldPos\.y,\s*b\.x\s*\)/);
  });

  it('the built-in sun light is not shadowed by the clouds under an aircraft flying on top', () => {
    const shared = createSkySharedUniforms();
    const sky = new SkySystem(new THREE.Scene(), stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: shared, builtinHeightFog: false });
    const deck: CloudLayer = { type: 'stratus', baseM: 900, topM: 1400, coverage: 1, density: 1 };
    const w: WeatherState = { ...weatherFromPreset('overcast', 4), clouds: [deck] };
    const h = 3000;
    sky.update(snapshot(NOON, w, h), new THREE.Vector3(0, h, 0), 1 / 60);
    const L = sky.lighting;
    // above every layer the aircraft gets the unobstructed sun (the dimming of L.sunIntensity undone)
    expect(sky.sunLight.intensity).toBeCloseTo(L.sunIntensity * shared.uCloudShadowNorm.value, 6);
    // under the deck it is in the shadow
    sky.update(snapshot(NOON, w, 200), new THREE.Vector3(0, 200, 0), 1 / 60);
    expect(sky.sunLight.intensity).toBeLessThan(sky.lighting.sunIntensity * shared.uCloudShadowNorm.value * 0.5);
    sky.dispose();
  });
});

describe('cloud type parameters (review)', () => {
  it('are shared constants, not a fresh object per call (called per layer every frame)', () => {
    for (const t of ['cumulus', 'stratus', 'cirrus'] as const) {
      expect(cloudTypeParams(t)).toBe(cloudTypeParams(t));
      expect(Object.isFrozen(cloudTypeParams(t))).toBe(true);
    }
  });
});
