import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { RUNWAY_NEAR_DROP_M, patchRunwayNearDrop } from './AirportsLayer';
import { runwayNearDropFor } from './World';
import { runwayGeometry } from './runwayGeometry';
import { LocalFrame } from '../geo/wgs84';
import type { Runway } from '../core/types';

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

  it('applies only with the camera near the ground', () => {
    expect(runwayNearDropFor(2)).toBe(1);
    expect(runwayNearDropFor(20)).toBe(1);
    expect(runwayNearDropFor(40)).toBeCloseTo(0.5, 6);
    expect(runwayNearDropFor(300)).toBe(0);
    expect(runwayNearDropFor(Number.NaN)).toBe(0);
  });
});
