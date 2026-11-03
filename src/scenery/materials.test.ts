import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SceneryMaterials, makeTreeGeometries } from './materials';
import { makeFacadeImages, makePavementImage, makeSpriteImage, WINDOW_U0, WINDOW_U1, WINDOW_V0, WINDOW_V1 } from './textures';
import { FACADE_CELLS } from './buildings';
import { nightFactor } from './config';
import { selectParking } from './parking';
import { TileProjector } from './tileMath';

type Shader = { uniforms: Record<string, { value: unknown }>; vertexShader: string; fragmentShader: string };
const compile = (m: THREE.Material, lib: { vertexShader: string; fragmentShader: string }): Shader => {
  const shader: Shader = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as unknown as THREE.WebGLRenderer);
  return shader;
};

describe('materials', () => {
  const mats = new SceneryMaterials();

  it('patches three chunks without removing them (log depth and reversed depth keep working)', () => {
    const s = compile(mats.surfaces, THREE.ShaderLib.standard);
    expect(s.vertexShader).toContain('mvPosition.xyz *= 1.0 - sceneryDepthBias * aBias;');
    expect(s.vertexShader).toContain('#include <logdepthbuf_vertex>');
    expect(s.vertexShader.indexOf('sceneryDepthBias * aBias')).toBeLessThan(s.vertexShader.indexOf('#include <logdepthbuf_vertex>'));
    expect(s.fragmentShader).toContain('irradiance = mix(');
    expect(s.fragmentShader).toContain('#include <logdepthbuf_fragment>');
    expect(s.uniforms.sceneryDepthBias).toBe(mats.depthBias);
    const walls = compile(mats.walls, THREE.ShaderLib.standard);
    expect(walls.fragmentShader).toContain('sceneryAmbientSat');
    expect(walls.vertexShader).not.toContain('aBias');
    const trees = compile(mats.trees, THREE.ShaderLib.lambert);
    expect(trees.fragmentShader).toContain('irradiance = mix(');
    const pts = compile(mats.streetlights, THREE.ShaderLib.points);
    expect(pts.vertexShader).toContain('gl_PointSize = max( gl_PointSize, sceneryMinPointPx );');
    expect(pts.vertexShader).toContain('#include <logdepthbuf_vertex>');
    // airport lights stand on biased pavement: they get the same relative bias or the pavement hides them from above
    const apt = compile(mats.airportLights, THREE.ShaderLib.points);
    expect(apt.vertexShader).toContain('mvPosition.xyz *= 1.0 - sceneryDepthBias;');
    expect(apt.vertexShader.indexOf('#include <project_vertex>')).toBeLessThan(apt.vertexShader.indexOf('1.0 - sceneryDepthBias;'));
    expect(apt.vertexShader.indexOf('1.0 - sceneryDepthBias;')).toBeLessThan(apt.vertexShader.indexOf('#include <logdepthbuf_vertex>'));
    expect(apt.uniforms.sceneryDepthBias).toBe(mats.depthBias);
    expect(pts.vertexShader).not.toContain('sceneryDepthBias');
    expect(mats.airportLights.customProgramCacheKey()).not.toBe(mats.streetlights.customProgramCacheKey());
    const pools = compile(mats.pools, THREE.ShaderLib.basic);
    expect(pools.vertexShader).toContain('sceneryDepthBias * aBias');
    // near-camera drop of airport surfaces: after begin_vertex (object space), before projection
    for (const sh of [s, compile(mats.markings, THREE.ShaderLib.standard), pools]) {
      const vs = sh.vertexShader;
      expect(vs).toContain('transformed.y -= sceneryNearDrop * aBias');
      expect(vs.indexOf('#include <begin_vertex>')).toBeLessThan(vs.indexOf('sceneryNearDrop * aBias'));
      expect(vs.indexOf('sceneryNearDrop * aBias')).toBeLessThan(vs.indexOf('#include <project_vertex>'));
      expect(sh.uniforms.sceneryNearDrop).toBe(mats.nearDrop);
    }
    expect(walls.vertexShader).not.toContain('sceneryNearDrop');
    expect(mats.nearDrop.value).toBeGreaterThan(0.1);
    expect(mats.nearDrop.value).toBeLessThan(0.2); // aprons stay above the terrain (0.20 m lift)
    // distinct program cache keys per patch set
    expect(mats.surfaces.customProgramCacheKey()).not.toBe(mats.walls.customProgramCacheKey());
  });

  it('fades night lighting with the sun elevation', () => {
    const deg = (d: number) => (d * Math.PI) / 180;
    expect(nightFactor(deg(30))).toBe(0);
    expect(nightFactor(deg(-4))).toBe(1);
    expect(nightFactor(deg(-20))).toBe(1);
    expect(nightFactor(deg(0))).toBeGreaterThan(0);
    expect(nightFactor(deg(0))).toBeLessThan(1);
    expect(nightFactor(NaN)).toBe(0);
    mats.setNight(0);
    expect(mats.walls.emissiveIntensity).toBe(0);
    expect(mats.streetlights.opacity).toBe(0);
    // no glowing sprites by day (floodlight sprites would float 22 m up without masts)
    expect(mats.airportLights.opacity).toBe(0);
    expect(mats.pools.opacity).toBe(0);
    mats.setNight(1);
    expect(mats.walls.emissiveIntensity).toBeGreaterThan(0);
    expect(mats.pools.opacity).toBeGreaterThan(0);
  });

  it('makes procedural textures in code: lit windows only inside panes, a fraction of them', () => {
    const f = makeFacadeImages(128);
    const cell = 128 / FACADE_CELLS;
    let litCells = 0;
    for (let cy = 0; cy < FACADE_CELLS; cy++) for (let cx = 0; cx < FACADE_CELLS; cx++) {
      const mid = ((cy * cell + Math.floor(cell * (WINDOW_V0 + WINDOW_V1) / 2)) * 128 + cx * cell + Math.floor(cell * 0.4)) * 4;
      if (f.emissive.data[mid] > 0) litCells++;
      const wall = ((cy * cell + 1) * 128 + cx * cell + 1) * 4;
      expect(f.emissive.data[wall]).toBe(0);
      expect(f.albedo.data[wall]).toBeGreaterThan(150);
    }
    expect(litCells).toBeGreaterThan(4);
    expect(litCells).toBeLessThan(40);
    expect(WINDOW_U1).toBeGreaterThan(WINDOW_U0);
    const pave = makePavementImage(64);
    let sum = 0;
    for (let i = 0; i < pave.data.length; i += 4) sum += pave.data[i];
    expect(sum / (pave.data.length / 4)).toBeGreaterThan(200);
    const sp = makeSpriteImage(32);
    expect(sp.data[(16 * 32 + 16) * 4 + 3]).toBeGreaterThan(200);
    expect(sp.data[3]).toBeLessThan(10);
  });

  it('builds low-poly trees with vertex colours and disposes everything', () => {
    const t = makeTreeGeometries();
    for (const g of [t.conifer, t.broadleaf]) {
      expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count);
      expect(g.getAttribute('position').count / 3).toBeLessThan(60);
      g.computeBoundingBox();
      expect(g.boundingBox!.max.y).toBeLessThanOrEqual(1.05);
      expect(g.boundingBox!.min.y).toBeGreaterThanOrEqual(-0.01);
    }
    const n = mats.textures.length;
    expect(n).toBeGreaterThan(5);
    mats.dispose();
    expect(mats.textures).toHaveLength(0);
  });
});

describe('selectParking', () => {
  it('converts, filters by radius, sorts nearest first (gates first on ties) and de-duplicates', () => {
    const p = new TileProjector(14, 2621, 6341);
    const c = p.toLonLat(0, 0);
    const spots = selectParking([
      { projector: p, spots: [
        { x: 100, z: 0, headingDeg: 90, name: 'Apron stand 1', kind: 'stand' },
        { x: 0, z: 50, headingDeg: 370, name: 'Gate A1', kind: 'gate' },
        { x: 0, z: 50.5, headingDeg: 10, name: 'Gate A1', kind: 'gate' }, // same gate from a neighbour tile
        { x: 900, z: 0, headingDeg: 0, name: 'far', kind: 'stand' },
        { x: 0, z: -70, headingDeg: -90, name: 'Apron stand 1', kind: 'stand' },
      ] },
    ], c.lat, c.lon, 500);
    expect(spots.map((s) => s.name)).toEqual(['Gate A1', 'Apron stand 1', 'Apron stand 1 (2)']);
    expect(spots[0].headingDeg).toBeCloseTo(10, 6);
    expect(spots[1].headingDeg).toBeCloseTo(270, 6); // 70 m away
    expect(spots[2].headingDeg).toBeCloseTo(90, 6); // 100 m away
    // the kind survives for the host (a light aircraft parks on a stand, not at a jet bridge)
    expect(spots.map((s) => s.kind)).toEqual(['gate', 'stand', 'stand']);
  });
});
