/**
 * Look pass 2 (after the light calibration): the civil-dusk sky and the residual sun under an overcast.
 * - Sky.js cuts its sun term ≈ 1–2° below the horizon and the night glow used to fade in only below −3°, so the dome
 *   was black (sRGB 0–4) from ≈ −2° to −6°, darker than the night sky. The twilight term + the night glow, composed
 *   with the sunlit sky by a smooth maximum, must carry the dome from the sunset into the night glow: monotonic,
 *   continuous, never below the night sky, and the day dome untouched.
 * - Under a full deck the cloud-shadow floor kept 15 % of the direct sun: white paint read brighter than the deck.
 *   The floor falls to ≈ 0.05 as cover closes and the skylight under a deck is π × the deck's radiance.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { Vec3, WeatherState } from '../core/types';
import { dirFromAzEl, sunPosition } from '../geo/solar';
import { cloudShadowFloor, cloudSunFactor, encodeDisplayColor, luminance } from './lighting';
import { skyExtraDayFade, skyLitMax, twilightColors, twilightStrength } from './preetham';
import { weatherFromPreset } from './presets';
import { SKY_LIT_MAX_LINE, type SkySnapshot, SkySystem, patchSkyDome } from './SkySystem';
import { cloudShadowAt, createSkySharedUniforms } from './skyUniforms';

function stubRenderer(): THREE.WebGLRenderer {
  return {
    toneMapping: THREE.NoToneMapping, toneMappingExposure: 1, outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap }, getPixelRatio: () => 1,
  } as unknown as THREE.WebGLRenderer;
}
const KSFO = { lat: 37.613538, lon: -122.35716 };
const DAY = Date.UTC(2026, 5, 21);
/** UTC (ms) on DAY when the sun's geometric elevation at KSFO crosses `el` in the afternoon, or its maximum ('noon'). */
function timeForElevation(el: number | 'noon'): number {
  let best = DAY, bestEl = -99;
  for (let m = 0; m < 1440; m += 1) { const t = DAY + m * 60_000; const e = sunPosition(t, KSFO.lat, KSFO.lon).elevation; if (e > bestEl) { bestEl = e; best = t; } }
  if (el === 'noon') return best;
  for (let t = best; t < best + 12 * 3_600_000; t += 10_000) if (sunPosition(t, KSFO.lat, KSFO.lon).elevation <= el) return t;
  throw new Error('no crossing');
}
function snapshot(utcMs: number, weather: WeatherState, heightM = 2): SkySnapshot {
  const aircraft = makeAircraftState({ posNED: [0, 0, -heightM], geo: { ...KSFO, alt: heightM }, altitudeAglM: heightM, altitudeMslM: heightM });
  return { time: { utcMs, timeScale: 1, simTimeS: 0 }, aircraft, weather, frame: { lat0: KSFO.lat, lon0: KSFO.lon, alt0: 0 } };
}
function makeSky(shared = createSkySharedUniforms()): SkySystem {
  return new SkySystem(new THREE.Scene(), stubRenderer(), { environmentMap: false, stars: 50, sharedUniforms: shared, builtinHeightFog: false });
}
const disp = (lin: Vec3, exposure: number): Vec3 => encodeDisplayColor(lin, exposure, [0, 0, 0]).map((v) => v * 255) as Vec3;

describe('civil-dusk sky: twilight term (dome and CPU twin)', () => {
  const clear = weatherFromPreset('clear', 4);
  /** dome samples (CPU twin the lighting uses) relative to the sun's azimuth */
  const VIEWS: Record<string, [number, number]> = { zenith: [0, 90], sky45: [90, 45], sky20: [90, 20], horizon90: [90, 3], antiSun: [180, 3], sunward: [0, 3] };
  function sample(sky: SkySystem): Record<string, number> {
    const az = (sky.sun.azimuthRad * 180) / Math.PI;
    const out: Record<string, number> = {};
    for (const [k, [daz, el]] of Object.entries(VIEWS)) out[k] = luminance(sky.preetham.radiance(dirFromAzEl(az + daz, el), [0, 0, 0]));
    return out;
  }

  it('darkens monotonically and continuously from a +4° sun to −12°, never below the night sky (no black gap)', () => {
    const sky = makeSky();
    sky.update(snapshot(timeForElevation(-25), clear), new THREE.Vector3(0, 2, 0), 1 / 60);
    const night = sample(sky);
    let prev: Record<string, number> | null = null;
    for (let el = 4; el >= -12; el -= 1) {
      sky.update(snapshot(timeForElevation(el), clear), new THREE.Vector3(0, 2, 0), 1 / 60);
      const s = sample(sky);
      for (const k of Object.keys(VIEWS)) {
        expect(Number.isFinite(s[k]), `${k} at ${el}°`).toBe(true);
        // never darker than the night sky (the old dome fell to ≈ 5 % of it between −2° and −6°)
        expect(s[k], `${k} at ${el}° vs night`).toBeGreaterThanOrEqual(night[k] * 0.98);
        if (prev) {
          expect(s[k], `${k} brightens from ${el + 1}° to ${el}°`).toBeLessThanOrEqual(prev[k] * 1.001);
          // continuous: no cliff away from the sun (sun-ward, Sky.js's own Mie glow still drops ≈ 4× within a degree)
          expect(prev[k] / s[k], `${k} step ${el + 1}° → ${el}°`).toBeLessThan(k === 'sunward' ? 5 : 2.5);
        }
      }
      prev = s;
    }
    sky.dispose();
  });

  it('twilight colours: deep-blue zenith, a warm band toward the sun fading with depression', () => {
    const sky = makeSky();
    sky.update(snapshot(timeForElevation(-3.5), clear), new THREE.Vector3(0, 2, 0), 1 / 60);
    const az = (sky.sun.azimuthRad * 180) / Math.PI;
    const z = sky.preetham.radiance([0, 1, 0], [0, 0, 0]);
    expect(z[2]).toBeGreaterThan(1.5 * z[0]); // blue zenith
    const toward = sky.preetham.radiance(dirFromAzEl(az, 3), [0, 0, 0]);
    const away = sky.preetham.radiance(dirFromAzEl(az + 180, 3), [0, 0, 0]);
    expect(toward[0]).toBeGreaterThan(toward[2]); // warm toward the sun …
    expect(luminance(toward)).toBeGreaterThan(1.3 * luminance(away)); // … and brighter than the anti-sun side
    // the GPU dome gets the very same terms (uniforms = the CPU twin's)
    const u = sky.sky.material.uniforms as Record<string, { value: THREE.Vector3 }>;
    expect(u.twilightBand.value.x).toBeCloseTo(sky.preetham.twilightBand[0], 9);
    expect(u.twilightZenith.value.z).toBeCloseTo(sky.preetham.twilightZenith[2], 9);
    expect(u.nightGlowHorizon.value.x).toBeCloseTo(sky.preetham.nightHorizon[0], 9);
    // fades with depression and is gone (with the night glow) by day
    expect(twilightStrength(-6)).toBeLessThan(0.1);
    expect(twilightStrength(-12)).toBeLessThan(0.002);
    expect(twilightStrength(-1)).toBeCloseTo(1, 6);
    expect(skyExtraDayFade(20)).toBe(0);
    expect(twilightColors(30).band).toEqual([0, 0, 0]);
    sky.dispose();
  });

  it('leaves the day dome exactly Sky.js and the golden-hour dome within a few percent', () => {
    for (const [el, tol] of [['noon', 1e-9], [20, 1e-9], [6, 0.06]] as const) {
      const sky = makeSky();
      sky.update(snapshot(timeForElevation(el), clear), new THREE.Vector3(0, 2, 0), 1 / 60);
      const az = (sky.sun.azimuthRad * 180) / Math.PI;
      const dirs = [[0, 90], [90, 45], [90, 3], [180, 3], [0, 3]].map(([daz, e]) => dirFromAzEl(az + daz, e));
      const withExtra = dirs.map((d) => luminance(sky.preetham.radiance(d, [0, 0, 0])));
      // the same twin without the night glow and the twilight = plain Sky.js (+ the in-scatter knee)
      sky.preetham.setNightGlow([0, 0, 0], [0, 0, 0]);
      sky.preetham.setTwilight([0, 0, 0], [0, 0, 0]);
      dirs.forEach((d, i) => expect(Math.abs(withExtra[i] / luminance(sky.preetham.radiance(d, [0, 0, 0])) - 1), `${el}: view ${i}`).toBeLessThanOrEqual(tol));
      sky.dispose();
    }
  });

  it('smooth maximum: the larger term wins, both equal → 2^¼ ×; the dome shader composes the same way', () => {
    expect(skyLitMax(0.3, 0)).toBeCloseTo(0.3, 12);
    expect(skyLitMax(0, 0.02)).toBeCloseTo(0.02, 12);
    expect(skyLitMax(1, 0.1)).toBeCloseTo(1, 3);
    expect(skyLitMax(0.5, 0.5)).toBeCloseTo(0.5 * 2 ** 0.25, 9);
    const dome = new Sky();
    patchSkyDome(dome.material);
    expect(dome.material.fragmentShader).toContain(SKY_LIT_MAX_LINE);
    expect(dome.material.fragmentShader).toContain('vec3 skyLitMax( vec3 a, vec3 b )');
    dome.geometry.dispose(); dome.material.dispose();
  });
});

describe('overcast residual sun and skylight', () => {
  it('the cloud-shadow floor falls from 0.15 to ≈ 0.05 as cover closes; the mean sun factor follows it', () => {
    for (const cc of [0, 0.2, 0.44, 0.5]) {
      expect(cloudShadowFloor(cc)).toBeCloseTo(0.15, 9);
      expect(cloudSunFactor(cc)).toBeCloseTo(1 - 0.85 * cc, 9); // unchanged up to half cover (scattered)
    }
    expect(cloudShadowFloor(1)).toBeCloseTo(0.05, 9);
    expect(cloudSunFactor(1)).toBeCloseTo(0.05, 9);
    let prev = 1;
    for (let cc = 0; cc <= 1.0001; cc += 0.05) { const f = cloudShadowFloor(cc); expect(f).toBeLessThanOrEqual(prev + 1e-12); prev = f; }
    expect(cloudShadowFloor(Number.NaN)).toBeCloseTo(0.15, 9);
  });

  it('under a noon overcast: ≈ 5 % of the sun, skylight = π × the deck, white paint about the deck’s brightness', () => {
    const noon = timeForElevation('noon');
    const sc = createSkySharedUniforms(), so = createSkySharedUniforms();
    const clear = makeSky(sc), ovc = makeSky(so);
    clear.update(snapshot(noon, weatherFromPreset('clear', 4)), new THREE.Vector3(0, 2, 0), 1 / 60);
    ovc.update(snapshot(noon, weatherFromPreset('overcast', 4)), new THREE.Vector3(0, 2, 0), 1 / 60);
    expect(so.uCloudShadowFloor.value).toBeCloseTo(0.05, 3);
    const ratio = ovc.sunLight.intensity / clear.sunLight.intensity;
    expect(ratio).toBeGreaterThan(0.035);
    expect(ratio).toBeLessThan(0.065); // was 0.15
    const deck: Vec3 = [0, 0, 0];
    expect(ovc.clouds.deckRadianceBelow(deck)).toBeGreaterThan(0.95);
    const L = ovc.lighting;
    const sky: Vec3 = [L.ambientIrradiance.r, L.ambientIrradiance.g, L.ambientIrradiance.b];
    expect(luminance(sky) / (Math.PI * luminance(deck))).toBeGreaterThan(0.97);
    expect(luminance(sky) / (Math.PI * luminance(deck))).toBeLessThan(1.1); // + the night-ambient floor only
    // white paint (albedo 0.85) on top, lit by the residual sun + the skylight, against the deck behind it
    const s = ovc.sunLight.intensity * Math.sin((L.sunElevationDeg * Math.PI) / 180);
    const E: Vec3 = [s * L.sunColor.r + sky[0], s * L.sunColor.g + sky[1], s * L.sunColor.b + sky[2]];
    const paint = luminance(disp([0.85 / Math.PI * E[0], 0.85 / Math.PI * E[1], 0.85 / Math.PI * E[2]], L.exposure));
    const deckD = luminance(disp(deck, L.exposure));
    expect(paint).toBeLessThan(deckD + 6); // was ≈ 223 against a deck of ≈ 200
    expect(paint).toBeGreaterThan(deckD - 20);
    expect(paint).toBeGreaterThan(195); // still a bright white under a bright deck
    clear.dispose(); ovc.dispose();
  });

  it('the deck twin mirrors the cloud planes’ underside formula', () => {
    const sky = makeSky();
    sky.update(snapshot(timeForElevation('noon'), weatherFromPreset('overcast', 4)), new THREE.Vector3(0, 2, 0), 1 / 60);
    const plane = sky.clouds.group.children.find((o) => o.visible) as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const fs = plane.material.fragmentShader;
    // CloudLayers.deckRadianceBelow evaluates exactly these two lines (back face, full density)
    expect(fs).toContain('vec3 col = uSkyAmbient * 0.8 + uSunRadiance * uBrightness * ( sunT * 0.9 + hg * 2.5 * powder * ( 1.0 - alpha ) );');
    expect(fs).toContain('if ( ! gl_FrontFacing ) col = col * 0.55 + uSkyAmbient * 0.25;');
    expect(fs).toContain('float sunT = exp( - thickness * uSigmaT * 0.6 );');
    const d: Vec3 = [0, 0, 0];
    expect(sky.clouds.deckRadianceBelow(d)).toBeGreaterThan(0.9);
    const amb = plane.material.uniforms.uSkyAmbient.value as THREE.Color;
    expect(d[1]).toBeGreaterThan(0.69 * amb.g); // ambient part + a little transmitted sun
    expect(d[1]).toBeLessThan(2 * amb.g);
    sky.dispose();
  });

  it('broken cloud keeps visible shadows (gaps in full sun); scattered is unchanged', () => {
    const noon = timeForElevation('noon');
    for (const [id, minContrast] of [['broken', 3], ['scattered', 3]] as const) {
      const shared = createSkySharedUniforms();
      const sky = makeSky(shared);
      sky.update(snapshot(noon, weatherFromPreset(id, 4)), new THREE.Vector3(0, 2, 0), 1 / 60);
      const L = sky.lighting;
      let lo = Infinity, hi = 0;
      for (let i = 0; i < 1600; i++) {
        const f = cloudShadowAt(shared, (i % 40) * 397 - 8000, 0, Math.floor(i / 40) * 401 - 8000, L.sunDirThree.x, L.sunDirThree.y, L.sunDirThree.z);
        lo = Math.min(lo, f); hi = Math.max(hi, f);
      }
      // the brightest sampled point: a full gap under scattered cumulus (the unobstructed sun), thinner cloud when broken
      expect(hi * cloudSunFactor(L.cloudCover), id).toBeGreaterThan(id === 'scattered' ? 0.99 : 0.3);
      expect(hi / lo, id).toBeGreaterThan(minContrast); // shadows stay visible
      if (id === 'scattered') expect(shared.uCloudShadowFloor.value).toBeCloseTo(0.15, 9);
      sky.dispose();
    }
  });
});
