import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AirportsLayer, RUNWAY_NEAR_DROP_M, RUNWAY_NEAR_END_M, RUNWAY_NEAR_FULL_M, patchRunwayNearDrop } from './AirportsLayer';
import { runwayNearDropFor } from './World';
import { runwayGeometry } from './runwayGeometry';
import { LocalFrame } from '../geo/wgs84';
import type { Airport, NavDatabase, Navaid, Runway } from '../core/types';

/** GLSL smoothstep */
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

describe('runway near-camera drop (wheels on the slab, not 0.12 m into it)', () => {
  it('patches the standard vertex shader after project_vertex with a shared uniform (log-depth chunk kept)', () => {
    const m = new THREE.MeshStandardMaterial();
    const drop = { value: 1 };
    patchRunwayNearDrop(m, drop, RUNWAY_NEAR_DROP_M.slab);
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.rwyNearDrop).toBe(drop);
    const vs = shader.vertexShader;
    expect(vs).toContain('uniform float rwyNearDrop;');
    expect(vs.indexOf('mvPosition.xyz -= ( viewMatrix')).toBeGreaterThan(vs.indexOf('#include <project_vertex>'));
    expect(vs.indexOf('#include <logdepthbuf_vertex>')).toBeGreaterThan(vs.indexOf('gl_Position = projectionMatrix * mvPosition;'));
    expect(m.customProgramCacheKey()).toContain('runway-near-drop');
  });

  it('brings slab, markings and designators to 12 / 14 / 16 mm near the camera, in that order, above the OSM taxiways (≤ 10 mm)', () => {
    const rw: Runway = { ident: '10L/28R', threshold: { lat: 37.628742, lon: -122.39341, alt: 1.5 }, end: { lat: 37.613538, lon: -122.35716, alt: 4 }, headingDeg: 118, lengthM: 3618, widthM: 61, surface: 'asphalt', lighted: true, displacedThresholdM: 0 };
    const frame = new LocalFrame(37.613538, -122.35716, 0);
    const g = runwayGeometry(rw, frame);
    const t = frame.geodeticToThree(rw.end.lat, rw.end.lon, rw.end.alt);
    const slab = g.ends[1].pos[1] - t[1]; // 0.12 m
    const near = { slab: slab - RUNWAY_NEAR_DROP_M.slab, markings: slab + 0.03 - RUNWAY_NEAR_DROP_M.markings, designator: slab + 0.04 - RUNWAY_NEAR_DROP_M.designator };
    expect(near.slab).toBeCloseTo(0.012, 4);
    expect(near.markings).toBeGreaterThan(near.slab);
    expect(near.designator).toBeGreaterThan(near.markings);
    expect(near.designator).toBeLessThan(0.02);
    expect(near.slab).toBeGreaterThan(0.0101); // OSM taxiway pavement next to runways tops out at 10 mm
  });

  it('the drawn slab is 12 mm up all along the runway around a camera at the wheels (the drop is per vertex: short slab segments)', () => {
    const rw: Runway = { ident: '10L/28R', threshold: { lat: 37.628742, lon: -122.39341, alt: 1.5 }, end: { lat: 37.613538, lon: -122.35716, alt: 4 }, headingDeg: 118, lengthM: 3618, widthM: 61, surface: 'asphalt', lighted: true, displacedThresholdM: 0 };
    const ap: Airport = { icao: 'KSFO', name: 'SFO', position: { lat: 37.62, lon: -122.375, alt: 4 }, elevationM: 4, type: 'large', country: 'US', runways: [rw] };
    const nav: NavDatabase = {
      loadRegion: async () => {}, getAirport: () => ap, nearestAirports: () => [ap], nearestNavaids: (): Navaid[] => [],
      searchAirports: () => [ap], findNavaidByFrequency: () => undefined, findIlsByFrequency: () => undefined,
    };
    const frame = new LocalFrame(37.613538, -122.35716, 0);
    const layer = new AirportsLayer(frame, nav);
    layer.ensureAirport(ap);
    let slab: THREE.Mesh | null = null;
    layer.group.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.name === 'runway:10L/28R') slab = o as THREE.Mesh; });
    expect(slab).not.toBeNull();
    const geo = (slab as unknown as THREE.Mesh).geometry;
    const pos = geo.getAttribute('position'), idx = geo.index!;
    const g = runwayGeometry(rw, frame);
    const a = g.ends[0].pos, b = g.ends[1].pos;
    let worst = 0, checked = 0;
    // wheels on the centre line every 7 m; cockpit camera 2 m above them, chase camera 15 m behind and 5 m up
    for (let s = 60; s < g.lengthM - 60; s += 7) {
      const t = s / g.lengthM, px = a[0] + (b[0] - a[0]) * t, pz = a[2] + (b[2] - a[2]) * t;
      for (const [back, up] of [[0, 2], [15, 5]]) {
        const cam = new THREE.Vector3(px - g.along[0] * back, a[1] + (b[1] - a[1]) * t + up, pz - g.along[2] * back);
        for (let k = 0; k < idx.count; k += 3) {
          const v = [idx.getX(k), idx.getX(k + 1), idx.getX(k + 2)].map((i) => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
          const d = (v[1].z - v[2].z) * (v[0].x - v[2].x) + (v[2].x - v[1].x) * (v[0].z - v[2].z);
          const l0 = ((v[1].z - v[2].z) * (px - v[2].x) + (v[2].x - v[1].x) * (pz - v[2].z)) / d;
          const l1 = ((v[2].z - v[0].z) * (px - v[2].x) + (v[0].x - v[2].x) * (pz - v[2].z)) / d;
          const l2 = 1 - l0 - l1;
          if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
          // what the vertex shader does per vertex (full strength), then the rasteriser's interpolation
          const drop = [l0, l1, l2].reduce((sum, l, i) => sum + l * RUNWAY_NEAR_DROP_M.slab * (1 - smooth(RUNWAY_NEAR_FULL_M, RUNWAY_NEAR_END_M, v[i].distanceTo(cam))), 0);
          worst = Math.max(worst, 0.12 - drop);
          checked++;
          break;
        }
      }
    }
    expect(checked).toBeGreaterThan(900);
    expect(worst).toBeLessThan(0.0135);
    layer.dispose();
  });

  it('applies only with the camera near the ground', () => {
    expect(runwayNearDropFor(2)).toBe(1);
    expect(runwayNearDropFor(20)).toBe(1);
    expect(runwayNearDropFor(40)).toBeCloseTo(0.5, 6);
    expect(runwayNearDropFor(300)).toBe(0);
    expect(runwayNearDropFor(Number.NaN)).toBe(0);
  });
});
