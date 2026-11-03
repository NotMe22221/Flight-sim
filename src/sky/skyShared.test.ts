import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { Vec3, WeatherState } from '../core/types';
import { builtinHeightFogValues, installBuiltinHeightFog } from './builtinFog';
import { luminance } from './lighting';
import { weatherFromPreset } from './presets';
import { cloudShadowAt, createSkySharedUniforms } from './skyUniforms';
import { type SkySnapshot, SkySystem, patchSkyDome, patchSkyDepth } from './SkySystem';

function stubRenderer(): THREE.WebGLRenderer {
  return {
    toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap }, getPixelRatio: () => 1,
  } as unknown as THREE.WebGLRenderer;
}
const KSFO = { lat: 37.613538, lon: -122.35716 };
const NOON = Date.UTC(2025, 5, 21, 20, 0);
const MIDNIGHT = Date.UTC(2025, 5, 21, 8, 0);
function snapshot(utcMs: number, weather: WeatherState, posNED: Vec3 = [0, 0, -2], agl = 2): SkySnapshot {
  const aircraft = makeAircraftState({ posNED, geo: { ...KSFO, alt: -posNED[2] }, altitudeAglM: agl, altitudeMslM: -posNED[2] });
  return { time: { utcMs, timeScale: 1, simTimeS: 0 }, aircraft, weather, frame: { lat0: KSFO.lat, lon0: KSFO.lon, alt0: 0 } };
}

describe('sky → other renderers', () => {
  it('publishes ambient irradiance, sky colours and cloud-shadow layers into its shared uniforms', () => {
    const shared = createSkySharedUniforms();
    const sky = new SkySystem(new THREE.Scene(), stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: shared });
    expect(shared.uSkyLinked.value).toBe(0);
    const w = weatherFromPreset('scattered', 4);
    sky.update(snapshot(NOON, w), new THREE.Vector3(0, 2, 0), 1 / 60);
    const L = sky.lighting;
    expect(shared.uSkyLinked.value).toBe(1);
    expect(shared.uSkyIrradiance.value.equals(L.ambientIrradiance)).toBe(true);
    expect(shared.uSkyZenith.value.equals(L.skyColorZenith)).toBe(true);
    // ambient irradiance = what the built-in lights give an up-facing surface
    const expected = sky.hemiLight.color.clone().multiplyScalar(sky.hemiLight.intensity).add(sky.ambientLight.color.clone().multiplyScalar(sky.ambientLight.intensity));
    expect(L.ambientIrradiance.r).toBeCloseTo(expected.r, 9);
    expect(L.ambientIrradiance.b).toBeCloseTo(expected.b, 9);
    // one cumulus layer: coverage, feature size, column optical depth, mid height
    const layer = w.clouds[0];
    expect(shared.uCloudShadowCount.value).toBe(w.clouds.filter((c) => c.coverage > 0.005 && c.density > 0.005).length);
    expect(shared.uCloudShadowA.value[0].x).toBeCloseTo(layer.coverage, 9);
    expect(shared.uCloudShadowA.value[0].w).toBeGreaterThan(0);
    expect(shared.uCloudShadowB.value[0].x).toBeCloseTo(0.5 * (layer.baseM + layer.topM), 6);
    expect(shared.uCloudShadowStrength.value).toBe(1);
    expect(shared.uCloudShadowNorm.value).toBeGreaterThan(1);
    // no shadows at night
    sky.update(snapshot(MIDNIGHT, w), new THREE.Vector3(0, 2, 0), 1 / 60);
    expect(shared.uCloudShadowStrength.value).toBe(0);
    sky.dispose();
  });

  it('cloud shadows: gaps get the full sun, shadows the floor, the ground average ≈ the dimmed sun', () => {
    const shared = createSkySharedUniforms();
    const sky = new SkySystem(new THREE.Scene(), stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: shared });
    expect(cloudShadowAt(shared, 0, 0, 0, 0, 1, 0)).toBe(1); // nothing published yet
    sky.update(snapshot(NOON, weatherFromPreset('scattered', 4)), new THREE.Vector3(0, 2, 0), 1 / 60);
    const s = sky.lighting.sunDirThree;
    let sum = 0, lo = Infinity, hi = -Infinity;
    const n = 1600;
    for (let i = 0; i < n; i++) {
      const f = cloudShadowAt(shared, (i % 40) * 397 - 8000, 0, Math.floor(i / 40) * 401 - 8000, s.x, s.y, s.z);
      sum += f; lo = Math.min(lo, f); hi = Math.max(hi, f);
    }
    expect(hi).toBeCloseTo(shared.uCloudShadowNorm.value, 6);
    expect(lo).toBeLessThan(0.5);
    expect(sum / n).toBeGreaterThan(0.7);
    expect(sum / n).toBeLessThan(1.3);
    // the built-in sun light carries the shadow at the aircraft
    const atAircraft = cloudShadowAt(shared, 0, 2, 0, s.x, s.y, s.z);
    expect(sky.sunLight.intensity).toBeCloseTo(sky.lighting.sunIntensity * atAircraft, 9);
    sky.dispose();
  });

  it('publishes nothing with sharedUniforms: null', () => {
    const sky = new SkySystem(new THREE.Scene(), stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: null });
    sky.update(snapshot(NOON, weatherFromPreset('few', 4)), new THREE.Vector3(0, 2, 0), 1 / 60);
    expect(sky.sharedUniforms).toBeNull();
    sky.dispose();
  });

  it('noon haze: blue-grey, darker than the horizon sky, and clouds fade into the sky instead', () => {
    const sky = new SkySystem(new THREE.Scene(), stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: null });
    sky.update(snapshot(NOON, weatherFromPreset('few', 4)), new THREE.Vector3(0, 2, 0), 1 / 60);
    const L = sky.lighting;
    const lum = (c: THREE.Color): number => luminance([c.r, c.g, c.b]);
    expect(lum(L.fogColor)).toBeLessThan(0.85 * lum(L.skyColorHorizon));
    expect(L.fogColor.b).toBeGreaterThan(L.fogColor.r);
    expect(lum(L.sunGlowColor)).toBeGreaterThan(lum(L.fogColor));
    expect(L.skyFogColor.equals(L.skyColorHorizon)).toBe(true);
    // displayed haze is a mid-light grey-blue, not white
    expect(L.fogColorEncoded.g).toBeLessThan(0.85);
    expect(L.fogColorEncoded.g).toBeGreaterThan(0.4);
    sky.dispose();
  });

  it('night: the dome glows faintly at the horizon and the ground ambient never reaches zero', () => {
    const sky = new SkySystem(new THREE.Scene(), stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: null });
    sky.update(snapshot(MIDNIGHT, weatherFromPreset('clear', 4)), new THREE.Vector3(0, 2, 0), 1 / 60);
    const L = sky.lighting;
    expect(luminance([L.skyColorHorizon.r, L.skyColorHorizon.g, L.skyColorHorizon.b])).toBeGreaterThan(0.01);
    expect(luminance([L.ambientIrradiance.r, L.ambientIrradiance.g, L.ambientIrradiance.b])).toBeGreaterThan(0.08);
    const u = sky.sky.material.uniforms;
    expect((u.nightGlowHorizon.value as THREE.Vector3).x).toBeGreaterThan(0);
    sky.dispose();
  });

  it('built-in height fog: patched chunks, shared values reach every cloned program uniform', () => {
    installBuiltinHeightFog();
    expect(THREE.ShaderChunk.fog_fragment).toContain('skyFogA');
    expect(THREE.ShaderChunk.fog_vertex).toContain('vFogWorldOffset');
    expect(THREE.ShaderChunk.fog_pars_fragment).toContain('skyFogSunLobe');
    // three keeps the plain FogExp2/linear maths when the values are absent (enabled = 0)
    expect(THREE.ShaderChunk.fog_fragment).toContain('fogDensity * fogDensity * vFogDepth * vFogDepth');
    expect(THREE.ShaderChunk.fog_fragment).toContain('smoothstep( fogNear, fogFar, vFogDepth )');
    for (const id of ['basic', 'lambert', 'phong', 'standard', 'physical', 'points', 'sprite']) {
      const lib = (THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, THREE.IUniform> }>)[id];
      expect(lib.uniforms.skyFogA, id).toBeDefined();
      const cloned = THREE.UniformsUtils.clone(lib.uniforms);
      expect(cloned.skyFogA.value).toBe(builtinHeightFogValues.a);
    }
    const sky = new SkySystem(new THREE.Scene(), stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: null });
    sky.update(snapshot(NOON, weatherFromPreset('few', 4), [0, 0, -300], 300), new THREE.Vector3(0, 300, 0), 1 / 60);
    const L = sky.lighting;
    expect(builtinHeightFogValues.a[0]).toBeCloseTo(L.fogDensity, 9);
    expect(builtinHeightFogValues.a[1]).toBeCloseTo(L.fogHeightFalloff, 9);
    expect(builtinHeightFogValues.a[2]).toBeCloseTo(L.groundY, 4);
    expect(builtinHeightFogValues.a[3]).toBe(1);
    expect(builtinHeightFogValues.b[1]).toBeCloseTo(L.sunDirThree.y, 6);
    sky.dispose();
  });

  it('patchSkyDome adds the in-scatter knee and the night glow once, next to the depth patch', () => {
    const dome = new Sky();
    patchSkyDepth(dome.material);
    patchSkyDome(dome.material);
    const fs = dome.material.fragmentShader;
    expect(fs).toContain('Lin *= 1.0 / ( 1.0 + dot( Lin');
    expect(fs).toContain('texColor += skyNightGlow( direction );');
    expect(fs.indexOf('uniform vec3 nightGlowHorizon')).toBeLessThan(fs.indexOf('void main()'));
    expect(dome.material.uniforms.nightGlowZenith).toBeDefined();
    patchSkyDome(dome.material);
    expect(dome.material.fragmentShader).toBe(fs);
    dome.geometry.dispose(); dome.material.dispose();
  });
});
