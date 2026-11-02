import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lonLatToTile, tileToLonLat, tileWidthMeters } from '../geo/mercator';
import { LocalFrame, destinationPoint } from '../geo/wgs84';
import { gridIndex, tileIndexCount, tileVertexCount } from './gridIndex';
import { decodeTerrariumPng } from './terrarium';
import { buildTileMesh, buildWaterPatch, skirtDepthFor } from './tileMesh';

const KSFO = { lat: 37.613538, lon: -122.35716 };
const ksfoTile = () => decodeTerrariumPng(new Uint8Array(readFileSync(new URL('./__fixtures__/terrarium-15-5246-12684.png', import.meta.url))));

describe('tileMesh', () => {
  const frame = new LocalFrame(KSFO.lat, KSFO.lon, 0);

  it('z15 KSFO tile with 64 quads: vertex/index counts, finite, bounded, AABB, normals, uvs', () => {
    const dem = ksfoTile();
    const skirt = skirtDepthFor(15, 37.6);
    const m = buildTileMesh(15, 5246, 12684, dem.heights, 256, frame, 64, skirt);
    expect(m.vertexCount).toBe(65 * 65 + 4 * 65);
    expect(m.vertexCount).toBe(tileVertexCount(64));
    expect(m.position.length).toBe(m.vertexCount * 3);
    expect(gridIndex(64).length).toBe(2 * 3 * (64 * 64 + 4 * 64));
    expect(tileIndexCount(64)).toBe(26112);
    const halfDiag = (tileWidthMeters(37.6, 15) * Math.SQRT2) / 2;
    for (let k = 0; k < m.vertexCount; k++) {
      const x = m.position[k * 3], y = m.position[k * 3 + 1], z = m.position[k * 3 + 2];
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
      expect(Math.hypot(x, y, z)).toBeLessThan(halfDiag + skirt);
      expect(x).toBeGreaterThanOrEqual(m.aabb.min[0]); expect(x).toBeLessThanOrEqual(m.aabb.max[0]);
      expect(y).toBeGreaterThanOrEqual(m.aabb.min[1]); expect(y).toBeLessThanOrEqual(m.aabb.max[1]);
      expect(z).toBeGreaterThanOrEqual(m.aabb.min[2]); expect(z).toBeLessThanOrEqual(m.aabb.max[2]);
      const nx = m.normal[k * 3], ny = m.normal[k * 3 + 1], nz = m.normal[k * 3 + 2];
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
      expect(ny).toBeGreaterThan(0.5);
      expect(m.uv[k * 2]).toBeGreaterThanOrEqual(0); expect(m.uv[k * 2]).toBeLessThanOrEqual(1);
      expect(m.uv[k * 2 + 1]).toBeGreaterThanOrEqual(0); expect(m.uv[k * 2 + 1]).toBeLessThanOrEqual(1);
    }
    expect(m.minH).toBe(Math.min(...m.height.subarray(0, 65 * 65)));
    expect(m.maxH).toBeGreaterThan(m.minH);
    // the tile is ~1 km from the frame origin, so its centre is close to the origin plane
    expect(Math.abs(m.centerThree[1])).toBeLessThan(50);
    // uv: vertex (0,0) is the NW corner → u = 0, v = 1; vertex (64,64) SE → (1, 0)
    expect(m.uv[0]).toBe(0); expect(m.uv[1]).toBe(1);
    const se = 64 * 65 + 64;
    expect(m.uv[se * 2]).toBe(1); expect(m.uv[se * 2 + 1]).toBe(0);
  });

  it('grid vertex heights are the bilinear DEM samples and skirts hang straight down', () => {
    const dem = ksfoTile();
    const m = buildTileMesh(15, 5246, 12684, dem.heights, 256, frame, 64, 40);
    // KSFO 28R threshold pixel (199,20) → grid position (199/4, 20/4) = (49.75, 5): compare with the nearest vertex
    const t = lonLatToTile(KSFO.lon, KSFO.lat, 15);
    const i = Math.round((t.x - 5246) * 64), j = Math.round((t.y - 12684) * 64);
    expect(Math.abs(m.height[j * 65 + i] - 3.96)).toBeLessThan(1.5);
    // skirt vertex below grid vertex (0,0): same x/z (within mm), 40 m lower
    const G = 65 * 65;
    expect(m.position[G * 3]).toBeCloseTo(m.position[0], 2);
    expect(m.position[G * 3 + 2]).toBeCloseTo(m.position[2], 2);
    expect(m.position[1] - m.position[G * 3 + 1]).toBeCloseTo(40, 2);
    expect(m.height[G]).toBe(m.height[0]);
    expect(m.normal[G * 3 + 1]).toBe(m.normal[1]);
  });

  it('a tile 100 km east of the origin has its centre ≈ 785 m below the tangent plane (curvature)', () => {
    const dest = destinationPoint({ lat: KSFO.lat, lon: KSFO.lon, alt: 0 }, 90, 100_000, 0);
    const t = lonLatToTile(dest.lon, dest.lat, 15);
    const x = Math.floor(t.x), y = Math.floor(t.y);
    const flat = new Float32Array(256 * 256);
    const m = buildTileMesh(15, x, y, flat, 256, frame, 16, 10);
    expect(m.centerThree[0]).toBeGreaterThan(99_000);
    expect(Math.abs(m.centerThree[1] - -785)).toBeLessThan(10);
    // positions are still small and bounded
    for (let k = 0; k < m.vertexCount; k++) expect(Math.hypot(m.position[k * 3], m.position[k * 3 + 1], m.position[k * 3 + 2])).toBeLessThan(800);
    // flat tile: normals point along the local vertical, tilted ~0.9° from +y at 100 km
    expect(m.normal[1]).toBeGreaterThan(0.999);
    expect(m.normal[0]).toBeGreaterThan(0.01); // tilts away from the origin: +d/R ≈ 0.0157
    // centreThree is exactly the frame transform of centreEcef
    const c = frame.ecefToThree(m.centerEcef);
    expect(c[0]).toBeCloseTo(m.centerThree[0], 6);
    expect(c[1]).toBeCloseTo(m.centerThree[1], 6);
  });

  it('skirt depth follows §3.3 clamp(0.05·width, 10, 400)', () => {
    expect(skirtDepthFor(15, 37.6)).toBeCloseTo(0.05 * tileWidthMeters(37.6, 15), 6);
    expect(skirtDepthFor(7, 37.6)).toBe(400);
    expect(skirtDepthFor(15, 85)).toBe(10);
  });

  it('water patch sits at h = 0 relative to the same centre and carries the terrain depth', () => {
    const dem = ksfoTile();
    const m = buildTileMesh(15, 5246, 12684, dem.heights, 256, frame, 32, 40);
    const w = buildWaterPatch(15, 5246, 12684, dem.heights, 256, frame, 32, m.centerEcef);
    expect(w.vertexCount).toBe(33 * 33);
    expect(w.depth.length).toBe(w.vertexCount);
    const c = tileToLonLat(5246.5, 12684.5, 15);
    const sea = frame.geodeticToThree(c.lat, c.lon, 0);
    const mid = 16 * 33 + 16;
    expect(w.position[mid * 3] + m.centerThree[0]).toBeCloseTo(sea[0], 2);
    expect(w.position[mid * 3 + 1] + m.centerThree[1]).toBeCloseTo(sea[1], 2);
    expect(w.position[mid * 3 + 2] + m.centerThree[2]).toBeCloseTo(sea[2], 2);
    expect(w.depth[mid]).toBeCloseTo(m.height[mid], 5);
    expect(w.normal[mid * 3 + 1]).toBeGreaterThan(0.999);
  });
});
