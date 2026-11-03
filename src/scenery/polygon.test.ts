import { describe, expect, it } from 'vitest';
import { cleanRing, clipPolylineToRect, clipRingToRect, closestOnPolyline, distToRingSq, orientedBox, pointInPolygon, reverseRing, ringCentroid, signedArea, triangulatePolygon } from './polygon';

const square = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1];
const triArea = (v: number[], a: number, b: number, c: number) =>
  ((v[2 * b] - v[2 * a]) * (v[2 * c + 1] - v[2 * a + 1]) - (v[2 * b + 1] - v[2 * a + 1]) * (v[2 * c] - v[2 * a])) / 2;

describe('triangulation with holes', () => {
  it('covers outer minus holes exactly, every triangle facing up', () => {
    const outer = square(0, 0, 100, 60);
    const holes = [reverseRing(square(10, 10, 30, 30)), reverseRing(square(60, 20, 90, 50))];
    const { verts, tris } = triangulatePolygon(outer, holes);
    let area = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const a = triArea(verts, tris[i], tris[i + 1], tris[i + 2]);
      // facing +Y in the render frame (x east, z south) ⇔ negative surveyor area
      expect(a).toBeLessThan(0);
      area -= a;
    }
    expect(area).toBeCloseTo(100 * 60 - 20 * 20 - 30 * 30, 6);
    // no triangle centroid inside a hole
    for (let i = 0; i < tris.length; i += 3) {
      const cx = (verts[2 * tris[i]] + verts[2 * tris[i + 1]] + verts[2 * tris[i + 2]]) / 3;
      const cy = (verts[2 * tris[i] + 1] + verts[2 * tris[i + 1] + 1] + verts[2 * tris[i + 2] + 1]) / 3;
      expect(pointInPolygon(cx, cy, outer, holes)).toBe(true);
    }
  });

  it('handles either input winding and a concave outline', () => {
    const l = [0, 0, 50, 0, 50, 10, 10, 10, 10, 40, 0, 40];
    for (const ring of [l, reverseRing(l)]) {
      const { verts, tris } = triangulatePolygon(ring, []);
      let area = 0;
      for (let i = 0; i < tris.length; i += 3) area -= triArea(verts, tris[i], tris[i + 1], tris[i + 2]);
      expect(area).toBeCloseTo(50 * 10 + 10 * 30, 6);
    }
  });
});

describe('clipping and ring helpers', () => {
  it('clips a ring to a rectangle (Sutherland–Hodgman) preserving area inside', () => {
    const r = clipRingToRect(square(-10, -10, 10, 10), { x0: 0, y0: 0, x1: 100, y1: 100 });
    expect(Math.abs(signedArea(r))).toBeCloseTo(100, 9);
    expect(clipRingToRect(square(200, 200, 300, 300), { x0: 0, y0: 0, x1: 100, y1: 100 })).toEqual([]);
    // a shared edge gives bit-identical intersections from both neighbours
    const tri = [-5, 3, 7, 9, 2, -4];
    const left = clipRingToRect(tri, { x0: -10, y0: -10, x1: 0, y1: 10 });
    const right = clipRingToRect(tri, { x0: 0, y0: -10, x1: 10, y1: 10 });
    const onEdge = (pts: number[]) => { const o: string[] = []; for (let i = 0; i < pts.length; i += 2) if (pts[i] === 0) o.push(`${pts[i + 1]}`); return o.sort(); };
    expect(onEdge(left)).toEqual(onEdge(right));
  });

  it('clips polylines into the inside pieces', () => {
    const parts = clipPolylineToRect([-10, 5, 5, 5, 5, 20, 5, 50, 20, 50], { x0: 0, y0: 0, x1: 10, y1: 30 });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual([0, 5, 5, 5, 5, 20, 5, 30]);
    const two = clipPolylineToRect([-5, 5, 15, 5, 15, 8, -5, 8], { x0: 0, y0: 0, x1: 10, y1: 10 });
    expect(two).toHaveLength(2);
  });

  it('cleans rings, measures distances, centroids and oriented boxes', () => {
    expect(cleanRing([0, 0, 0, 0, 10, 0, 20, 0, 20, 10, 0, 10, 0, 0])).toEqual([0, 0, 20, 0, 20, 10, 0, 10]);
    expect(distToRingSq(5, 5, square(0, 0, 10, 10))).toBeCloseTo(25, 9);
    const c = ringCentroid(square(0, 0, 10, 20));
    expect(c.x).toBeCloseTo(5, 9);
    expect(c.y).toBeCloseTo(10, 9);
    // a 30 × 10 rectangle rotated by 30°
    const a = Math.PI / 6, pts: number[] = [];
    for (const [i, j] of [[-15, -5], [15, -5], [15, 5], [-15, 5]]) pts.push(i * Math.cos(a) - j * Math.sin(a) + 100, i * Math.sin(a) + j * Math.cos(a) + 50);
    const b = orientedBox(pts);
    expect(b.halfLen).toBeCloseTo(15, 6);
    expect(b.halfWid).toBeCloseTo(5, 6);
    expect(Math.abs(b.ux * Math.cos(a) + b.uy * Math.sin(a))).toBeCloseTo(1, 6);
    expect(b.cx).toBeCloseTo(100, 6);
    const o = { x: 0, y: 0, d2: 0 };
    closestOnPolyline(5, 5, [0, 0, 10, 0], o);
    expect(o).toEqual({ x: 5, y: 0, d2: 25 });
  });
});
