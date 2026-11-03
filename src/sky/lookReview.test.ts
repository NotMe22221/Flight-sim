/**
 * Regression tests from the adversarial review of the look pass (sky side): cloud shadows along the
 * sun ray only, no per-frame allocation in the cloud parameters, one fog ground reference for every
 * renderer, built-in skylight = terrain skylight at every sun height, dispose unlinks process-wide state.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { CloudLayer, Vec3, WeatherState } from '../core/types';
import { builtinHeightFogValues } from './builtinFog';
import { cloudTypeParams } from './cloudMath';
import { luminance, skylightBalance } from './lighting';
import { PreethamSky } from './preetham';
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

describe('one fog ground reference for every renderer (review)', () => {
  it('publishes the ground height the sky’s fog is referenced to', () => {
    const shared = createSkySharedUniforms();
    const sky = new SkySystem(new THREE.Scene(), stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: shared, builtinHeightFog: false });
    // aircraft 300 m up, 260 m above its ground ⇒ ground at render y 40
    const snap = snapshot(NOON, weatherFromPreset('few', 4), 300);
    snap.aircraft.altitudeAglM = 260;
    sky.update(snap, new THREE.Vector3(0, 300, 0), 1 / 60);
    expect(sky.lighting.groundY).toBeCloseTo(40, 6);
    expect(shared.uSkyGroundY.value).toBeCloseTo(40, 6);
    sky.dispose();
  });
});

/** Fine midpoint quadrature of ∫ L cosθ dω over the upper hemisphere (reference for the cheap estimate). */
function fineIrradiance(p: PreethamSky): Vec3 {
  const E: Vec3 = [0, 0, 0], out: Vec3 = [0, 0, 0], N = 64, M = 128;
  for (let i = 0; i < N; i++) {
    const th = ((i + 0.5) / N) * (Math.PI / 2);
    for (let j = 0; j < M; j++) {
      const ph = ((j + 0.5) / M) * 2 * Math.PI;
      p.radiance([Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)], out);
      const w = Math.cos(th) * Math.sin(th) * (Math.PI / 2 / N) * ((2 * Math.PI) / M);
      for (let c = 0; c < 3; c++) E[c] += out[c] * w;
    }
  }
  return E;
}

describe('skylight on built-in materials follows the terrain’s at every sun height (review)', () => {
  const DUSK = Date.UTC(2025, 5, 22, 3, 30); // sun ≈ 0° at KSFO
  const AFTERNOON = Date.UTC(2025, 5, 22, 0, 0); // ≈ 40°, like the November "noon" preset

  it('PreethamSky.irradianceUp matches a fine quadrature of the dome (noon, low sun, sunset)', () => {
    const p = new PreethamSky();
    for (const el of [75, 40, 10, 2, 0]) {
      const r = (el * Math.PI) / 180;
      p.setSun([0, Math.sin(r), -Math.cos(r)], { turbidity: 2.5, rayleigh: 1, mieCoefficient: 0.005, mieDirectionalG: 0.8 });
      const ref = fineIrradiance(p), est = p.irradianceUp([0, 0, 0]);
      expect(luminance(est) / luminance(ref)).toBeGreaterThan(0.97);
      expect(luminance(est) / luminance(ref)).toBeLessThan(1.03);
    }
  });

  it('skylightBalance: the environment and hemisphere light add up to the terrain skylight, reflections capped', () => {
    const o = { envIntensity: 0, hemiShare: 0 };
    // bright dome (noon): the environment carries 75 %, the hemisphere light 25 %
    skylightBalance(0.86, 1.9, 0.25, 1, o);
    expect(o.envIntensity * 1.9 + o.hemiShare * 0.86).toBeCloseTo(0.86, 9);
    expect(o.hemiShare).toBeCloseTo(0.25, 9);
    // sunset: the dome is ≈ 27× dimmer, the environment is capped at 1 and the hemisphere light fills in
    skylightBalance(0.49, 0.07, 0.25, 1, o);
    expect(o.envIntensity).toBe(1);
    expect(o.envIntensity * 0.07 + o.hemiShare * 0.49).toBeCloseTo(0.49, 9);
    // degenerate inputs
    skylightBalance(0.5, 0, 0.25, 1, o);
    expect(o).toEqual({ envIntensity: 0, hemiShare: 1 });
    skylightBalance(0, 1, 0.25, 1, o);
    expect(o.hemiShare).toBe(1);
  });

  it('SkySystem: with its baked environment bound, built-ins get the terrain’s skylight at noon and at dusk', () => {
    const scene = new THREE.Scene();
    const sky = new SkySystem(scene, stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: null, builtinHeightFog: false });
    // stand-in for a successful PMREM bake (the stub renderer cannot bake)
    const tex = new THREE.Texture();
    const s = sky as unknown as { envTarget: unknown; measureEnvironment(): void; envIrradianceLum: number };
    s.envTarget = { texture: tex, dispose: () => {} };
    scene.environment = tex;
    for (const utc of [AFTERNOON, DUSK]) {
      for (let i = 0; i < 2; i++) {
        sky.update(snapshot(utc, weatherFromPreset('few', 4), 260), new THREE.Vector3(0, 260, 0), 1 / 60);
        s.measureEnvironment();
      }
      const hemi = sky.hemiLight.color;
      const L = sky.lighting;
      const terrainSky = luminance([L.ambientIrradiance.r, L.ambientIrradiance.g, L.ambientIrradiance.b]) - luminance([sky.ambientLight.color.r, sky.ambientLight.color.g, sky.ambientLight.color.b]) * sky.ambientLight.intensity;
      const builtins = sky.hemiLight.intensity * luminance([hemi.r, hemi.g, hemi.b]) + scene.environmentIntensity * s.envIrradianceLum;
      expect(builtins / terrainSky).toBeGreaterThan(0.99);
      expect(builtins / terrainSky).toBeLessThan(1.01);
      expect(scene.environmentIntensity).toBeLessThanOrEqual(1);
      expect(scene.environmentIntensity).toBeGreaterThan(0);
    }
    sky.dispose();
  });
});

describe('dispose (review)', () => {
  it('unlinks what it published process-wide: built-in height fog off, shared uniforms marked unlinked', () => {
    const shared = createSkySharedUniforms();
    const sky = new SkySystem(new THREE.Scene(), stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: shared });
    sky.update(snapshot(NOON, weatherFromPreset('few', 4), 300), new THREE.Vector3(0, 300, 0), 1 / 60);
    expect(builtinHeightFogValues.a[3]).toBe(1);
    expect(shared.uSkyLinked.value).toBe(1);
    sky.dispose();
    // another FogExp2 scene (or the next SkySystem before its first update) must not inherit stale height fog
    expect(builtinHeightFogValues.a[3]).toBe(0);
    // terrain materials fall back to their own sun/ambient/fog inputs
    expect(shared.uSkyLinked.value).toBe(0);
    expect(shared.uCloudShadowStrength.value).toBe(0);
  });
});
