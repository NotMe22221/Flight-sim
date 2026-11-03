/**
 * 2-D polygon helpers on flat [x0, y0, x1, y1, …] rings (rings closed implicitly).
 * Used both in tile coordinates and in tile-local metres (x = east, y = south), which share
 * orientation: a positive `signedArea` ring is clockwise seen from above with north up.
 */
import { ShapeUtils, Vector2 } from 'three';

/** Surveyor's signed area (positive = clockwise on a y-down screen = MVT exterior). */
export function signedArea(ring: ArrayLike<number>): number {
  let s = 0;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) s += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
  return s / 2;
}

export function reverseRing(ring: readonly number[]): number[] {
  const out: number[] = new Array(ring.length);
  for (let i = 0, j = ring.length - 2; j >= 0; i += 2, j -= 2) { out[i] = ring[j]; out[i + 1] = ring[j + 1]; }
  return out;
}

/** Remove a repeated closing point, consecutive duplicates and (nearly) collinear vertices. */
export function cleanRing(ring: readonly number[], eps = 1e-6): number[] {
  const pts: number[] = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const x = ring[2 * i], y = ring[2 * i + 1];
    const m = pts.length;
    if (m >= 2 && Math.abs(pts[m - 2] - x) <= eps && Math.abs(pts[m - 1] - y) <= eps) continue;
    pts.push(x, y);
  }
  while (pts.length >= 4 && Math.abs(pts[0] - pts[pts.length - 2]) <= eps && Math.abs(pts[1] - pts[pts.length - 1]) <= eps) pts.length -= 2;
  // collinear removal (cross product relative to edge lengths)
  let changed = true;
  while (changed && pts.length > 6) {
    changed = false;
    const m = pts.length / 2;
    for (let i = 0; i < m && pts.length > 6; i++) {
      const p = (i + m - 1) % m, q = (i + 1) % m;
      const ax = pts[2 * p], ay = pts[2 * p + 1], bx = pts[2 * i], by = pts[2 * i + 1], cx = pts[2 * q], cy = pts[2 * q + 1];
      const cr = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
      const l = Math.hypot(bx - ax, by - ay) * Math.hypot(cx - bx, cy - by);
      if (Math.abs(cr) <= 1e-9 * Math.max(l, 1e-12) + eps * eps) {
        pts.splice(2 * i, 2);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** Sutherland–Hodgman clip of a ring to an axis-aligned rectangle (result may be empty). */
export function clipRingToRect(ring: readonly number[], r: Rect): number[] {
  let pts: number[] = ring.slice();
  for (let edge = 0; edge < 4 && pts.length >= 6; edge++) {
    const out: number[] = [];
    const n = pts.length / 2;
    const inside = (x: number, y: number): boolean => (edge === 0 ? x >= r.x0 : edge === 1 ? x <= r.x1 : edge === 2 ? y >= r.y0 : y <= r.y1);
    for (let i = 0; i < n; i++) {
      const ax = pts[2 * ((i + n - 1) % n)], ay = pts[2 * ((i + n - 1) % n) + 1];
      const bx = pts[2 * i], by = pts[2 * i + 1];
      const ain = inside(ax, ay), bin = inside(bx, by);
      if (ain !== bin) {
        // canonical endpoint order so a shared edge gives bit-identical intersections
        const swap = ax > bx || (ax === bx && ay > by);
        const px = swap ? bx : ax, py = swap ? by : ay, qx = swap ? ax : bx, qy = swap ? ay : by;
        let t: number, ix: number, iy: number;
        if (edge < 2) { const c = edge === 0 ? r.x0 : r.x1; t = (c - px) / (qx - px); ix = c; iy = py + (qy - py) * t; }
        else { const c = edge === 2 ? r.y0 : r.y1; t = (c - py) / (qy - py); iy = c; ix = px + (qx - px) * t; }
        out.push(ix, iy);
      }
      if (bin) out.push(bx, by);
    }
    pts = out;
  }
  return pts.length >= 6 ? pts : [];
}

/** Clip a polyline to a rectangle (Liang–Barsky per segment); returns the inside pieces. */
export function clipPolylineToRect(line: readonly number[], r: Rect): number[][] {
  const parts: number[][] = [];
  let cur: number[] | null = null;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i], ay = line[i + 1], bx = line[i + 2], by = line[i + 3];
    const dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    const p = [-dx, dx, -dy, dy], q = [ax - r.x0, r.x1 - ax, ay - r.y0, r.y1 - ay];
    for (let k = 0; k < 4 && ok; k++) {
      if (p[k] === 0) { if (q[k] < 0) ok = false; }
      else {
        const t = q[k] / p[k];
        if (p[k] < 0) { if (t > t1) ok = false; else if (t > t0) t0 = t; }
        else { if (t < t0) ok = false; else if (t < t1) t1 = t; }
      }
    }
    if (!ok || t1 - t0 <= 0) { cur = null; continue; }
    const sx = ax + dx * t0, sy = ay + dy * t0, ex = ax + dx * t1, ey = ay + dy * t1;
    if (cur && t0 === 0) cur.push(ex, ey);
    else { cur = [sx, sy, ex, ey]; parts.push(cur); }
    if (t1 < 1) cur = null;
  }
  return parts;
}

/** Even-odd point-in-ring test. */
export function pointInRing(x: number, y: number, ring: ArrayLike<number>): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x: number, y: number, outer: ArrayLike<number>, holes: readonly ArrayLike<number>[]): boolean {
  if (!pointInRing(x, y, outer)) return false;
  for (const h of holes) if (pointInRing(x, y, h)) return false;
  return true;
}

export function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px, ey = ay + dy * t - py;
  return ex * ex + ey * ey;
}

/** Squared distance from a point to a ring's edges (closed). */
export function distToRingSq(px: number, py: number, ring: ArrayLike<number>): number {
  let best = Infinity;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const d = distToSegmentSq(px, py, ring[j], ring[j + 1], ring[i], ring[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

/** Squared distance from a point to an open polyline, and the closest point on it. */
export function closestOnPolyline(px: number, py: number, line: ArrayLike<number>, out: { x: number; y: number; d2: number }): { x: number; y: number; d2: number } {
  out.d2 = Infinity;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i], ay = line[i + 1], bx = line[i + 2], by = line[i + 3];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + dx * t, cy = ay + dy * t;
    const d2 = (cx - px) ** 2 + (cy - py) ** 2;
    if (d2 < out.d2) { out.d2 = d2; out.x = cx; out.y = cy; }
  }
  return out;
}

export function ringBounds(ring: ArrayLike<number>): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i], y = ring[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/** Area centroid of a ring (falls back to the vertex mean for degenerate rings). */
export function ringCentroid(ring: ArrayLike<number>): { x: number; y: number } {
  let a = 0, cx = 0, cy = 0;
  const n = ring.length;
  const ox = ring[0], oy = ring[1];
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xj = ring[j] - ox, yj = ring[j + 1] - oy, xi = ring[i] - ox, yi = ring[i + 1] - oy;
    const c = xj * yi - xi * yj;
    a += c; cx += (xj + xi) * c; cy += (yj + yi) * c;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i += 2) { sx += ring[i]; sy += ring[i + 1]; }
    return { x: sx / (n / 2), y: sy / (n / 2) };
  }
  return { x: ox + cx / (3 * a), y: oy + cy / (3 * a) };
}

export interface OrientedBox {
  cx: number; cy: number;
  /** unit vector of the long axis */
  ux: number; uy: number;
  halfLen: number; halfWid: number;
  area: number;
}

/** Minimum-area bounding rectangle among the ring's edge directions. */
export function orientedBox(ring: ArrayLike<number>): OrientedBox {
  const n = ring.length;
  let best: OrientedBox | null = null;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    let ux = ring[i] - ring[j], uy = ring[i + 1] - ring[j + 1];
    const l = Math.hypot(ux, uy);
    if (l < 1e-9) continue;
    ux /= l; uy /= l;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let k = 0; k < n; k += 2) {
      const a = ring[k] * ux + ring[k + 1] * uy, b = -ring[k] * uy + ring[k + 1] * ux;
      if (a < a0) a0 = a;
      if (a > a1) a1 = a;
      if (b < b0) b0 = b;
      if (b > b1) b1 = b;
    }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area - 1e-9) {
      const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
      const cx = ca * ux - cb * uy, cy = ca * uy + cb * ux;
      const la = (a1 - a0) / 2, lb = (b1 - b0) / 2;
      best = la >= lb
        ? { cx, cy, ux, uy, halfLen: la, halfWid: lb, area }
        : { cx, cy, ux: -uy, uy: ux, halfLen: lb, halfWid: la, area };
    }
  }
  return best ?? { cx: ring[0] ?? 0, cy: ring[1] ?? 0, ux: 1, uy: 0, halfLen: 0, halfWid: 0, area: 0 };
}

/** Polyline length. */
export function polylineLength(line: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i + 3 < line.length; i += 2) s += Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]);
  return s;
}

/**
 * Triangulate a polygon with holes (THREE.ShapeUtils / earcut). Returns vertex coordinates
 * (outer then holes, flat xy) and triangle indices, every triangle with positive
 * `signedArea` orientation reversed so that it faces up (+Y) in the render frame.
 */
export function triangulatePolygon(outer: readonly number[], holes: readonly (readonly number[])[]): { verts: number[]; tris: number[] } {
  const toV = (r: readonly number[]): Vector2[] => {
    const out: Vector2[] = [];
    for (let i = 0; i < r.length; i += 2) out.push(new Vector2(r[i], r[i + 1]));
    return out;
  };
  const contour = toV(outer);
  const hv = holes.filter((h) => h.length >= 6).map(toV);
  const faces = ShapeUtils.triangulateShape(contour, hv);
  const verts: number[] = [];
  for (const v of contour) verts.push(v.x, v.y);
  for (const h of hv) for (const v of h) verts.push(v.x, v.y);
  const tris: number[] = [];
  for (const f of faces) {
    const [a, b, c] = f;
    // faces up (+Y) when the triangle is counter-clockwise on a y-down screen (negative surveyor area)
    const cr = (verts[2 * b] - verts[2 * a]) * (verts[2 * c + 1] - verts[2 * a + 1]) - (verts[2 * b + 1] - verts[2 * a + 1]) * (verts[2 * c] - verts[2 * a]);
    if (cr === 0) continue;
    if (cr > 0) tris.push(a, c, b);
    else tris.push(a, b, c);
  }
  return { verts, tris };
}
