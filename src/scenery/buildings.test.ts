import { describe, expect, it } from 'vitest';
import { FACADE_CELLS, WALL_SKIRT_M, buildBuildings, classifyBuilding, type BuildingInput } from './buildings';
import type { MeshData } from './protocol';
import { reverseRing, signedArea } from './polygon';

/** Exterior rings are clockwise seen from above (positive surveyor area in x-east / y-south). */
const rect = (x0: number, z0: number, x1: number, z1: number): number[] => {
  const r = [x0, z0, x1, z0, x1, z1, x0, z1];
  return signedArea(r) > 0 ? r : reverseRing(r);
};
const building = (outer: number[], height: number, extra: Partial<BuildingInput> = {}): BuildingInput => ({ outer, holes: [], height, minHeight: 0, colour: null, id: 1, ...extra });

interface Tri { a: number[]; b: number[]; c: number[]; n: number[]; stored: number[] }
function triangles(m: MeshData, fromIndex = 0, toIndex = m.index.length): Tri[] {
  const out: Tri[] = [];
  const P = (i: number) => [m.position[i * 3], m.position[i * 3 + 1], m.position[i * 3 + 2]];
  for (let k = fromIndex; k < toIndex; k += 3) {
    const a = P(m.index[k]), b = P(m.index[k + 1]), c = P(m.index[k + 2]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    const i0 = m.index[k];
    out.push({ a, b, c, n: n.map((x) => x / l), stored: [m.normal[i0 * 3], m.normal[i0 * 3 + 1], m.normal[i0 * 3 + 2]] });
  }
  return out;
}

describe('extrusion', () => {
  it('walls face outward with counter-clockwise winding and storey-scaled UVs; flat roof faces up', () => {
    const r = buildBuildings([building(rect(0, 0, 30, 20), 24)], { maxTriangles: 1e6, pitchedRoofs: false })!;
    expect(r.count).toBe(1);
    const walls = triangles(r.walls);
    expect(walls.length).toBe(8);
    for (const t of walls) {
      const cx = (t.a[0] + t.b[0] + t.c[0]) / 3 - 15, cz = (t.a[2] + t.b[2] + t.c[2]) / 3 - 10;
      expect(t.n[0] * cx + t.n[2] * cz).toBeGreaterThan(0); // outward
      expect(Math.abs(t.n[1])).toBeLessThan(1e-6); // vertical
      expect(t.n[0] * t.stored[0] + t.n[2] * t.stored[2]).toBeGreaterThan(0.999); // stored normal = winding normal
    }
    const ys = Array.from(r.walls.position).filter((_, i) => i % 3 === 1);
    expect(Math.min(...ys)).toBeCloseTo(-WALL_SKIRT_M, 6);
    expect(Math.max(...ys)).toBeCloseTo(24, 6);
    // v spans the height in storeys (3 m each, FACADE_CELLS per repeat); u spans whole window bays
    const v = Array.from(r.walls.uv!).filter((_, i) => i % 2 === 1);
    expect((Math.max(...v) - Math.min(...v)) * 3 * FACADE_CELLS).toBeCloseTo(24 + WALL_SKIRT_M, 4);
    const roof = triangles(r.roofs);
    expect(roof.length).toBe(2);
    for (const t of roof) { expect(t.n[1]).toBeGreaterThan(0.999); expect(t.a[1]).toBeCloseTo(24, 6); }
  });

  it('courtyard holes get walls facing into the courtyard; elevated parts get a floor', () => {
    const r = buildBuildings([building(rect(0, 0, 40, 40), 15, { holes: [reverseRing(rect(10, 10, 30, 30))] }), building(rect(100, 0, 120, 20), 30, { minHeight: 20, id: 2 })], { maxTriangles: 1e6, pitchedRoofs: false })!;
    expect(r.count).toBe(2);
    // buildings are ordered by importance: find the elevated part by its centroid
    const elevated = Math.abs(r.centroids[0] - 110) < 1 ? 0 : 1;
    const court = 1 - elevated;
    const b0 = { s: r.ranges[court * 6], n: r.ranges[court * 6 + 1] };
    let inward = 0;
    for (const t of triangles(r.walls)) {
      const cx = (t.a[0] + t.b[0] + t.c[0]) / 3, cz = (t.a[2] + t.b[2] + t.c[2]) / 3;
      if (cx < 0 || cx > 40) continue;
      const inner = cx > 9 && cx < 31 && cz > 9 && cz < 31;
      if (inner) { inward++; expect(t.n[0] * (cx - 20) + t.n[2] * (cz - 20)).toBeLessThan(0); }
    }
    expect(inward).toBe(8);
    expect(b0.n).toBeGreaterThan(0);
    // elevated part: walls from 20 m (no skirt) and a downward floor
    const roofs = triangles(r.roofs);
    expect(roofs.some((t) => t.n[1] < -0.999 && Math.abs(t.a[1] - 20) < 1e-6)).toBe(true);
    const ys: number[] = [];
    for (let v = r.ranges[elevated * 6]; v < r.ranges[elevated * 6] + r.ranges[elevated * 6 + 1]; v++) ys.push(r.walls.position[v * 3 + 1]);
    expect(Math.min(...ys)).toBeCloseTo(20, 6);
  });

  it('builds hip or gable roofs for small houses, every facet facing up and out', () => {
    let hips = 0, gables = 0;
    for (let id = 1; id <= 40; id++) {
      const r = buildBuildings([building(rect(0, 0, 14, 9), 8, { id })], { maxTriangles: 1e6, pitchedRoofs: true })!;
      const roof = triangles(r.roofs);
      const slopes = roof.filter((t) => t.n[1] > 0.05 && t.n[1] < 0.99);
      expect(slopes.length).toBeGreaterThanOrEqual(4);
      for (const t of slopes) {
        const cx = (t.a[0] + t.b[0] + t.c[0]) / 3 - 7, cz = (t.a[2] + t.b[2] + t.c[2]) / 3 - 4.5;
        expect(t.n[0] * cx + t.n[2] * cz).toBeGreaterThan(-1e-6);
      }
      const top = Math.max(...Array.from(r.roofs.position).filter((_, i) => i % 3 === 1));
      expect(top).toBeCloseTo(8, 4);
      // gable ends are wall triangles
      const gableWalls = triangles(r.walls).filter((t) => Math.max(t.a[1], t.b[1], t.c[1]) > 7.9);
      if (gableWalls.length > 0) gables++; else hips++;
    }
    expect(hips).toBeGreaterThan(3);
    expect(gables).toBeGreaterThan(3);
  });

  it('classifies footprints', () => {
    expect(classifyBuilding(150, 7, 0, 0, 0.95, true)).toBe('house');
    expect(classifyBuilding(150, 7, 0, 0, 0.95, false)).toBe('windowed');
    expect(classifyBuilding(150, 7, 0, 0, 0.6, true)).toBe('windowed'); // L-shaped: flat roof
    expect(classifyBuilding(150, 20, 0, 0, 0.95, true)).toBe('windowed');
    expect(classifyBuilding(5000, 12, 0, 0, 0.95, true)).toBe('plain');
  });

  it('skips walls along the tile edge, orders big buildings first and honours the triangle cap', () => {
    const outer = rect(0, 0, 10, 10);
    // vertices on the tile edge carry the same edge bit: the wall between them is skipped
    const edge = new Uint8Array(4);
    for (let i = 0; i < 4; i++) if (outer[2 * i] === 10) edge[i] = 2;
    const r = buildBuildings([building(outer, 6, { outerEdge: edge })], { maxTriangles: 1e6, pitchedRoofs: false })!;
    expect(triangles(r.walls).length).toBe(6);
    const many: BuildingInput[] = [];
    for (let i = 0; i < 50; i++) many.push(building(rect(i * 30, 0, i * 30 + 10, 10), i === 25 ? 60 : 6, { id: i + 1 }));
    const all = buildBuildings(many, { maxTriangles: 1e6, pitchedRoofs: false })!;
    expect(all.count).toBe(50);
    // the tall one is first, and the "big" prefix covers exactly it
    expect(all.centroids[0]).toBeCloseTo(25 * 30 + 5, 6);
    expect(all.bigIndexCount[0]).toBe(8 * 3);
    const capped = buildBuildings(many, { maxTriangles: 100, pitchedRoofs: false })!;
    expect(capped.count).toBeLessThan(50);
    expect((capped.walls.index.length + capped.roofs.index.length) / 3).toBeLessThanOrEqual(100 + 10);
  });
});
