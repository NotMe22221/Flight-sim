import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { Vec3, WeatherState } from '../core/types';
import { dirFromAzEl, sunPosition } from '../geo/solar';
import { encodeDisplayColor, heightFogOpticalDepth } from './lighting';
import { weatherFromPreset } from './presets';
import { Sky } from 'three/addons/objects/Sky.js';
import { type SkySnapshot, SkySystem, patchSkyDepth } from './SkySystem';
import { WeatherSystem } from './WeatherSystem';

/** Just enough of a WebGLRenderer for SkySystem to run in Node (no PMREM bake). */
function stubRenderer(): THREE.WebGLRenderer {
  return {
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap },
    getPixelRatio: () => 1,
  } as unknown as THREE.WebGLRenderer;
}

const KSFO = { lat: 37.613538, lon: -122.35716 };
/** 2025-06-21 20:00 UTC ≈ local solar noon at KSFO; 2025-06-21 08:00 UTC ≈ local midnight. */
const NOON = Date.UTC(2025, 5, 21, 20, 0);
const MIDNIGHT = Date.UTC(2025, 5, 21, 8, 0);

function snapshot(utcMs: number, weather: WeatherState, posNED: Vec3 = [0, 0, -2], agl = 2, alt0 = 0): SkySnapshot {
  const aircraft = makeAircraftState({ posNED, geo: { ...KSFO, alt: alt0 - posNED[2] }, altitudeAglM: agl, altitudeMslM: alt0 - posNED[2] });
  return { time: { utcMs, timeScale: 1, simTimeS: 0 }, aircraft, weather, frame: { lat0: KSFO.lat, lon0: KSFO.lon, alt0 } };
}

function makeSky(): { sky: SkySystem; scene: THREE.Scene; renderer: THREE.WebGLRenderer } {
  const scene = new THREE.Scene();
  const renderer = stubRenderer();
  const sky = new SkySystem(scene, renderer, { environmentMap: false, stars: 200 });
  return { sky, scene, renderer };
}

describe('SkySystem (stub renderer)', () => {
  it('sets ACES tone mapping and enables shadows; adds its renderables to the scene', () => {
    const { sky, scene, renderer } = makeSky();
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(scene.fog).toBe(sky.fog);
    for (const name of ['sky', 'sunLight', 'moonLight', 'skyLight', 'ambientFloor', 'stars', 'moon', 'cloudLayers', 'precipitation']) {
      expect(scene.getObjectByName(name)).toBeDefined();
    }
    sky.dispose();
    expect(scene.fog).toBeNull();
    expect(scene.getObjectByName('sky')).toBeUndefined();
  });

  it('places the sun from the NOAA position at the aircraft lat/lon and sim UTC (render frame x E, y U, z S)', () => {
    const { sky } = makeSky();
    const cam = new THREE.Vector3(0, 2, 0);
    sky.update(snapshot(NOON, weatherFromPreset('clear', 4)), cam, 1 / 60);
    const sp = sunPosition(NOON, KSFO.lat, KSFO.lon);
    const d = dirFromAzEl(sp.azimuth, sp.apparentElevation);
    const L = sky.lighting;
    expect(L.sunDirThree.x).toBeCloseTo(d[0], 9);
    expect(L.sunDirThree.y).toBeCloseTo(d[1], 9);
    expect(L.sunDirThree.z).toBeCloseTo(d[2], 9);
    // June noon at 37.6°N: sun high in the SOUTH ⇒ +z (south) component, ~76° elevation
    expect(L.sunElevationDeg).toBeGreaterThan(70);
    expect(L.sunDirThree.z).toBeGreaterThan(0);
    expect(sky.sun.elevationRad).toBeCloseTo((sp.elevation * Math.PI) / 180, 9);
    expect(sky.sun.azimuthRad).toBeCloseTo((sp.azimuth * Math.PI) / 180, 9);
    expect(sky.sun.dirThree).toEqual([d[0], d[1], d[2]]);
    // the DirectionalLight shines from the sun toward the aircraft
    expect(sky.sunLight.intensity).toBeGreaterThan(1);
    const toSun = sky.sunLight.position.clone().sub(sky.sunLight.target.position).normalize();
    expect(toSun.dot(L.sunDirThree)).toBeCloseTo(1, 9);
    expect(sky.sunLight.target.position.distanceTo(new THREE.Vector3(0, 2, 0))).toBeLessThan(1e-9);
    // the shadow frustum is the configured ~200 m box
    const sc = sky.sunLight.shadow.camera;
    expect(sc.right - sc.left).toBe(400);
    expect(sc.top - sc.bottom).toBe(400);
    sky.dispose();
  });

  it('fog: Koschmieder β = 3.912 / visibility, FogExp2 density 1.978 / V at the ground', () => {
    const { sky } = makeSky();
    const w = weatherFromPreset('overcast', 4); // 8 km visibility
    w.clouds = [];
    sky.update(snapshot(NOON, w), new THREE.Vector3(0, 2, 0), 1 / 60);
    expect(sky.lighting.fogDensity).toBeCloseTo(3.912 / 8000, 12);
    // camera ~0 m AGL ⇒ the height factor is ≈ 1
    expect(sky.fog.density).toBeCloseTo(1.978 / 8000, 6);
    expect(sky.lighting.fogExp2Density).toBe(sky.fog.density);
    sky.dispose();
  });

  it('fog colour reaches the GPU as the tone-mapped, sRGB-encoded horizon colour (no double encoding)', () => {
    const { sky, renderer } = makeSky();
    sky.update(snapshot(NOON, weatherFromPreset('clear', 4)), new THREE.Vector3(0, 2, 0), 1 / 60);
    const L = sky.lighting;
    const expected = encodeDisplayColor([L.fogColor.r, L.fogColor.g, L.fogColor.b], L.exposure);
    // three r187 uploads fog.color converted to renderer.outputColorSpace (refreshFogUniforms → getRGB)
    const uploaded = new THREE.Color();
    sky.fog.color.getRGB(uploaded, renderer.outputColorSpace);
    expect(uploaded.r).toBeCloseTo(expected[0], 5);
    expect(uploaded.g).toBeCloseTo(expected[1], 5);
    expect(uploaded.b).toBeCloseTo(expected[2], 5);
    expect(L.fogColorEncoded.r).toBeCloseTo(expected[0], 5);
    sky.dispose();
  });

  it('shares the WeatherSystem cloud field and keeps it attached to the ground across a floating-origin rebase', () => {
    const { sky } = makeSky();
    const ws = new WeatherSystem({ initial: 'scattered', airportElevationM: 4 });
    for (let i = 0; i < 100; i++) ws.update(1);
    sky.setCloudDrifts(ws.cloudDrifts);
    const cam = new THREE.Vector3(0, 2, 0);
    sky.update(snapshot(NOON, ws.state), cam, 1 / 60);
    const mid = 0.5 * (ws.state.clouds[0].baseM + ws.state.clouds[0].topM);
    // sample a line of world points: the renderer's field and the FDM's field must be identical
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 40; i++) pts.push(new THREE.Vector3(i * 731 - 9000, mid, i * 377 - 4000));
    const before = pts.map((p) => sky.cloudDensityAt(p));
    expect(before.some((d) => d > 0)).toBe(true);
    pts.forEach((p, i) => expect(ws.cloudDensityAt(p.x, p.y, p.z)).toBeCloseTo(before[i], 12));
    // origin moves 15 km east / 8 km north: every render position changes by −m
    const m = new THREE.Vector3(15_000, 0, -8_000);
    ws.notifyRebase(m.x, m.z);
    sky.notifyRebase(m);
    sky.update(snapshot(NOON, ws.state), cam, 1 / 60);
    pts.forEach((p, i) => {
      const q = p.clone().sub(m);
      expect(sky.cloudDensityAt(q)).toBeCloseTo(before[i], 9);
      expect(ws.cloudDensityAt(q.x, q.y, q.z)).toBeCloseTo(before[i], 9);
    });
    sky.dispose();
  });

  it('self-integrated cloud drift also survives a rebase', () => {
    const { sky } = makeSky();
    const w = weatherFromPreset('scattered', 4);
    const cam = new THREE.Vector3(0, 2, 0);
    for (let i = 0; i < 10; i++) sky.update(snapshot(NOON, w), cam, 1);
    const mid = 0.5 * (w.clouds[0].baseM + w.clouds[0].topM);
    const pts = Array.from({ length: 30 }, (_, i) => new THREE.Vector3(i * 911 - 7000, mid, 3000 - i * 517));
    const before = pts.map((p) => sky.cloudDensityAt(p));
    const m = new THREE.Vector3(-12_000, 0, 6_000);
    sky.notifyRebase(m);
    pts.forEach((p, i) => expect(sky.cloudDensityAt(p.clone().sub(m))).toBeCloseTo(before[i], 9));
    sky.dispose();
  });

  it('treats render y as altitude relative to the frame origin (MSL = y + alt0)', () => {
    const { sky } = makeSky();
    const w = weatherFromPreset('overcast', 1600); // OVC 2100–3100 m MSL
    const alt0 = 1600;
    // camera 1000 m above the origin = 2600 m MSL: inside the overcast deck
    const cam = new THREE.Vector3(0, 1000, 0);
    sky.update(snapshot(NOON, w, [0, 0, -1000], 1000, alt0), cam, 1 / 60);
    expect(sky.lighting.inCloud).toBeGreaterThan(0.9);
    expect(sky.cloudDensityAt(cam)).toBeGreaterThan(0.9);
    const plane = sky.clouds.group.children[0];
    expect(plane.position.y).toBeCloseTo(1000, 6); // follows the camera inside the layer
    // camera at 200 m above the origin (1800 m MSL) is below the deck: plane at the base, render y = 2100 − 1600
    sky.update(snapshot(NOON, w, [0, 0, -200], 200, alt0), new THREE.Vector3(0, 200, 0), 1 / 60);
    expect(sky.lighting.inCloud).toBe(0);
    expect(plane.position.y).toBeCloseTo(500, 6);
    sky.dispose();
  });

  it('a ground fog layer still hides the ground from above, and thins out above its top', () => {
    const { sky } = makeSky();
    const w = weatherFromPreset('clear', 4);
    w.clouds = []; w.visibilityM = 400; w.fogTopM = 150;
    const L = sky.lighting;
    const od = (h0: number, dirY: number, dist: number) => heightFogOpticalDepth(h0, dirY, dist, L.fogDensity, L.fogHeightFalloff);
    // in the fog at the surface: the reported visibility (Koschmieder)
    sky.update(snapshot(NOON, w, [0, 0, -2], 2), new THREE.Vector3(0, 2, 0), 1 / 60);
    expect(L.fogDensity * Math.exp(-2 * L.fogHeightFalloff)).toBeCloseTo(3.912 / 400, 3);
    // 1000 m above: looking straight down, the 150 m layer still obscures the ground…
    sky.update(snapshot(NOON, w, [0, 0, -1000], 1000), new THREE.Vector3(0, 1000, 0), 1 / 60);
    expect(1 - Math.exp(-od(1000, -1, 1000))).toBeGreaterThan(0.6);
    // …while the air at the camera is clear (horizontal visibility > 20 km)
    const betaCam = L.fogDensity * Math.exp(-1000 * L.fogHeightFalloff);
    expect(3.912 / betaCam).toBeGreaterThan(20_000);
    sky.dispose();
  });

  it('inside a cloud the height-fog extinction at the camera reaches the in-cloud β (fly-through fog)', () => {
    const { sky } = makeSky();
    const w = weatherFromPreset('overcast', 0); // OVC 500–1500 m, vis 8 km
    const L = sky.lighting;
    sky.update(snapshot(NOON, w, [0, 0, -1000], 1000), new THREE.Vector3(0, 1000, 0), 1 / 60);
    expect(L.inCloud).toBeGreaterThan(0.9);
    const betaCam = L.fogDensity * Math.exp(-1000 * L.fogHeightFalloff);
    expect(betaCam).toBeGreaterThan(0.9 * 0.03);
    // visibility inside ≈ 3.912 / 0.03 ≈ 130 m: a point 300 m away is fogged out in any direction
    for (const dirY of [-1, -0.3, 0, 0.3, 1]) expect(1 - Math.exp(-heightFogOpticalDepth(1000, dirY, 300, L.fogDensity, L.fogHeightFalloff))).toBeGreaterThan(0.9);
    // the built-in FogExp2 agrees (2 % contrast at ≈ 130 m)
    expect(1.978 / sky.fog.density).toBeLessThan(160);
    // below the deck the fog is the 8 km haze again
    sky.update(snapshot(NOON, w, [0, 0, -100], 100), new THREE.Vector3(0, 100, 0), 1 / 60);
    expect(L.inCloud).toBe(0);
    expect(L.fogDensity).toBeCloseTo(3.912 / 8000, 12);
    for (const v of [L.fogDensity, L.fogHeightFalloff, L.exposure, L.sunIntensity, L.ambientIntensity]) expect(Number.isFinite(v)).toBe(true);
    sky.dispose();
  });

  it('patchSkyDepth keeps the r187 sky dome at the far plane in normal and reversed depth, with clean directives', () => {
    const dome = new Sky();
    patchSkyDepth(dome.material);
    const vs = dome.material.vertexShader;
    expect(vs).toContain('#ifdef USE_REVERSED_DEPTH_BUFFER');
    expect(vs).toMatch(/gl_Position\.z = 0\.0;/);
    expect(vs).toMatch(/gl_Position\.z = gl_Position\.w;/);
    // no trailing tokens/comments after #else / #endif (strict GLSL ES preprocessors reject them)
    for (const line of vs.split('\n')) {
      const t = line.trim();
      if (t.startsWith('#else') || t.startsWith('#endif')) expect(t === '#else' || t === '#endif').toBe(true);
    }
    patchSkyDepth(dome.material);
    expect(dome.material.vertexShader).toBe(vs); // idempotent
    dome.geometry.dispose(); dome.material.dispose();
  });

  it('cloud planes use this frame\'s fog (no one-frame lag) and the first frame starts at the target exposure', () => {
    const { sky } = makeSky();
    const w = weatherFromPreset('overcast', 4);
    sky.update(snapshot(MIDNIGHT, w), new THREE.Vector3(0, 2, 0), 1 / 60);
    const L = sky.lighting;
    const u = (sky.clouds.group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>).material.uniforms;
    expect(u.uFogBeta.value).toBe(L.fogDensity);
    expect(u.uFogInvH.value).toBe(L.fogHeightFalloff);
    expect((u.uHorizonColor.value as THREE.Color).equals(L.skyFogColor)).toBe(true);
    // night: no fade-in from the day exposure on the very first frame
    expect(L.exposure).toBeGreaterThan(1.2);
    expect(sky.renderer.toneMappingExposure).toBe(L.exposure);
    // stars and moonlight at night, no sun
    expect(sky.sunLight.visible).toBe(false);
    expect(L.ambientIntensity).toBeGreaterThan(0);
    sky.dispose();
  });
});
