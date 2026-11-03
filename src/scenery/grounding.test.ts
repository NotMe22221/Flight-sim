import { describe, expect, it } from 'vitest';
import { LocalFrame } from '../geo/wgs84';
import { GroundSampler, TilePlacement, markRange, type UpdateRange } from './grounding';
import { BuildingLayer, DrapeLayer, PointLayer, TreeLayer } from './layers';
import { buildBuildings } from './buildings';
import { TileProjector } from './tileMath';
import { makeHost, type HeightFn } from './testUtil';
import * as THREE from 'three';
import { reverseRing, signedArea } from './polygon';

const tile = new TileProjector(14, 2621, 6341);
const rect = (x0: number, z0: number, x1: number, z1: number): number[] => {
  const r = [x0, z0, x1, z0, x1, z1, x0, z1];
  return signedArea(r) > 0 ? r : reverseRing(r);
};
const hills: HeightFn = (lat, lon) => 120 + 40 * Math.sin(lat * 900) * Math.cos(lon * 700);

/** World-space geodetic altitude error of local point (x, y, z) against the terrain. */
function altError(frame: LocalFrame, pl: TilePlacement, x: number, y: number, z: number, h: HeightFn): number {
  const w = { x: 0, y: 0, z: 0 };
  pl.toWorld(x, y, z, w);
  const g = frame.threeToGeodetic(w.x, w.y, w.z);
  return g.alt - h(g.lat, g.lon);
}

describe('ground sampling in the tile frame', () => {
  it('lands on the terrain through a rotated, tilted frame, within centimetres after one refinement', () => {
    const frame = new LocalFrame(37.75, -122.55, 0); // ~ 20 km away from the tile
    const host = makeHost(frame, hills);
    const pl = new TilePlacement();
    pl.set(tile.frame, frame);
    const s = new GroundSampler(host.groundUp);
    for (const [x, z] of [[0, 0], [700, -500], [-900, 800]]) {
      const y1 = s.sample(pl, x, z, 0);
      expect(Math.abs(altError(frame, pl, x, y1, z, hills))).toBeLessThan(0.5); // 32 % slopes, 0.18° tilt
      const y2 = s.sample(pl, x, z, y1);
      // residual: groundUp(n, e) reads the terrain along the geodetic vertical of the tangent-plane
      // point, ≈ height × tilt (0.4 m) sideways of the frame vertical: ≤ slope × 0.4 m ≈ 0.13 m here
      expect(Math.abs(altError(frame, pl, x, y2, z, hills))).toBeLessThan(0.15);
    }
    expect(s.calls).toBe(6);
    expect(Number.isNaN(new GroundSampler(() => null).sample(pl, 0, 0, 0))).toBe(true);
  });
});

describe('ground layers', () => {
  const frame = new LocalFrame(tile.centerLat, tile.centerLon, 0);
  const pl = new TilePlacement();
  pl.set(tile.frame, frame);

  it('keeps buildings collapsed until their ground exists, then places and re-places them', () => {
    const data = buildBuildings([
      { outer: rect(0, 0, 20, 20), holes: [], height: 10, minHeight: 0, colour: null, id: 1 },
      { outer: rect(500, 500, 540, 530), holes: [], height: 30, minHeight: 0, colour: null, id: 2 },
    ], { maxTriangles: 1e6, pitchedRoofs: false })!;
    const layer = new BuildingLayer(data);
    // collapsed: every triangle has zero area
    const pos = layer.gpu[0];
    const idx = data.walls.index;
    const area = (k: number) => {
      const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    };
    for (let k = 0; k < idx.length; k += 3) expect(area(k)).toBe(0);
    // terrain only under the first building (east < 300 m of the tile centre)
    let h: HeightFn | null = (lat, lon) => (lon < tile.centerLon + 0.0034 ? 50 : NaN);
    const host = makeHost(frame, (lat, lon) => (h ? h(lat, lon) : NaN));
    const s = new GroundSampler((n, e) => { const u = host.groundUp(n, e); return u === null || Number.isNaN(u) ? null : u; });
    layer.step(1000, s, pl);
    layer.flush();
    expect(layer.firstPassDone).toBe(true);
    expect(layer.groundedCount).toBe(1);
    const iFirst = Math.abs(data.centroids[0] - 520) < 1 ? 1 : 0; // ordering: the taller one first
    expect(Number.isFinite(layer.groundOf(iFirst))).toBe(true);
    expect(Number.isNaN(layer.groundOf(1 - iFirst))).toBe(true);
    expect(Math.abs(altError(frame, pl, data.centroids[iFirst * 2], layer.groundOf(iFirst), data.centroids[iFirst * 2 + 1], () => 50))).toBeLessThan(0.05);
    expect(layer.attrs[0].updateRanges.length + layer.attrs[2].updateRanges.length).toBeGreaterThan(0);
    // terrain arrives everywhere, then refines by +3 m: gradual re-sampling follows
    h = () => 50;
    for (let i = 0; i < 4; i++) layer.step(1000, s, pl);
    expect(layer.complete).toBe(true);
    const before = layer.groundOf(0);
    h = () => 53;
    for (let i = 0; i < 4; i++) layer.step(5, s, pl);
    expect(layer.groundOf(0) - before).toBeCloseTo(3, 2);
    expect(layer.groundOf(1) - before).toBeCloseTo(3, 1);
    // vertices moved with it: the roof is at ground + height
    const roof = layer.gpu[2];
    const s0 = data.ranges[0 * 6 + 4];
    expect(roof[s0 * 3 + 1] - layer.groundOf(0)).toBeCloseTo(data.roofs.position[s0 * 3 + 1], 4);
  });

  it('drapes vertices, lights and trees on the ground', () => {
    const host = makeHost(frame, () => 12);
    const s = new GroundSampler(host.groundUp);
    const pos = new Float32Array([0, 0, 0, 100, 0, 0, 0, 0, 100]);
    const drape = new DrapeLayer({ mesh: { position: pos, normal: new Float32Array(9), uv: null, color: null, index: new Uint32Array([0, 2, 1]) }, lift: new Float32Array([0.2, 0.2, 0.03]) });
    drape.step(100, s, pl);
    drape.flush();
    for (let i = 0; i < 3; i++) expect(Math.abs(altError(frame, pl, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], () => 12) - [0.2, 0.2, 0.03][i])).toBeLessThan(0.01);
    expect(Array.from(drape.bias.array as Uint8Array)).toEqual([255, 255, 0]);
    const pts = new PointLayer({ xz: new Float32Array([10, 10]), height: new Float32Array([8]), color: new Uint8Array([255, 200, 100]), count: 1 });
    pts.step(10, s, pl);
    const p = pts.attr.array as Float32Array;
    expect(altError(frame, pl, p[0], p[1], p[2], () => 12)).toBeCloseTo(8, 1);
    const trees = new TreeLayer(new Float32Array([5, 5, 12, 0.5]), new Uint8Array([255, 255, 255]), new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    const m = trees.mesh.instanceMatrix.array as Float32Array;
    expect(m[5]).toBe(0); // zero scale before grounding
    trees.step(10, s, pl);
    expect(m[5]).toBeCloseTo(12, 6);
    expect(altError(frame, pl, m[12], m[13] + 0.3, m[14], () => 12)).toBeCloseTo(0, 1);
    trees.mesh.dispose();
  });

  it('keeps one persistent update range per attribute and widens it while pending', () => {
    const a = { updateRanges: [] as UpdateRange[], needsUpdate: false };
    const r: UpdateRange = { start: 0, count: 0 };
    markRange(a, r, 30, 6);
    markRange(a, r, 3, 3);
    expect(a.updateRanges).toEqual([{ start: 3, count: 33 }]);
    expect(a.updateRanges[0]).toBe(r);
    a.updateRanges.length = 0; // uploaded
    markRange(a, r, 90, 3);
    expect(a.updateRanges).toEqual([{ start: 90, count: 3 }]);
    expect(a.needsUpdate).toBe(true);
  });
});
