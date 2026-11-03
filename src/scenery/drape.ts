/**
 * Surfaces draped on the terrain (aprons, taxiway polygons and ribbons, markings, light pools).
 *
 * Polygons are triangulated once, then every triangle is clipped against a square grid in the
 * tile-local frame so no edge is longer than about one cell; vertices are shared through an
 * exact-coordinate map, so after per-vertex ground sampling the surface has no cracks.
 * Ribbons (taxiway centre lines) are resampled along their length with mitred joins.
 * Vertex y holds 0; the per-vertex lift above the ground travels in `lift`.
 */
import { MeshBuilder, FloatList } from './meshBuilder';
import type { DrapedData } from './protocol';
import { clipRingToRect, triangulatePolygon, type Rect } from './polygon';

export type LiftFn = (x: number, z: number) => number;
/** true when the point lies on a runway (geometry there is dropped / lowered) */
export type ZoneFn = (x: number, z: number) => boolean;

export class DrapeBuilder {
  readonly mesh: MeshBuilder;
  readonly lift = new FloatList(1024);
  private map = new Map<string, number>();
  /** planar UV scale (m per repeat); 0 = caller-supplied UVs */
  readonly uvScale: number;

  constructor(uvScale = 10, initialVertices = 2048) {
    this.mesh = new MeshBuilder(true, true, initialVertices);
    this.uvScale = uvScale;
  }

  get vertexCount(): number { return this.mesh.vertexCount; }
  get triangleCount(): number { return this.mesh.triangleCount; }

  /** Start a new shared-vertex scope (vertices are only shared inside one feature). */
  newScope(): void { this.map.clear(); }

  vertex(x: number, z: number, lift: number, r: number, g: number, b: number, u?: number, v?: number): number {
    const key = `${Math.round(x * 64)}:${Math.round(z * 64)}`;
    if (u === undefined) {
      const hit = this.map.get(key);
      if (hit !== undefined) return hit;
    }
    const s = this.uvScale || 1;
    const i = this.mesh.vertex(x, 0, z, 0, 1, 0, u ?? x / s, v ?? z / s, r, g, b);
    this.lift.push(lift);
    if (u === undefined) this.map.set(key, i);
    return i;
  }

  /** Triangle forced to face up (+Y). */
  triangleUp(a: number, b: number, c: number): void {
    const m = this.mesh;
    const cr = (m.getX(b) - m.getX(a)) * (m.getZ(c) - m.getZ(a)) - (m.getZ(b) - m.getZ(a)) * (m.getX(c) - m.getX(a));
    if (cr === 0) return;
    if (cr > 0) m.triangle(a, c, b);
    else m.triangle(a, b, c);
  }

  finish(): DrapedData | null {
    if (this.mesh.indexCount === 0) return null;
    return { mesh: this.mesh.finish(), lift: this.lift.finish() };
  }
}

export interface DrapeStyle {
  r: number; g: number; b: number;
  lift: LiftFn;
  /** drop a triangle when its vertices are on a runway: 'all' three or 'any' one */
  drop: ZoneFn | null;
  dropMode: 'all' | 'any';
}

const cellRect: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Drape a polygon with holes, clipped to a `cellM` grid. Returns the triangles added. */
export function drapePolygon(d: DrapeBuilder, outer: readonly number[], holes: readonly (readonly number[])[], cellM: number, st: DrapeStyle): number {
  const t = triangulatePolygon(outer, holes);
  if (t.tris.length === 0) return 0;
  d.newScope();
  const before = d.triangleCount;
  const V = t.verts;
  const tri: number[] = [0, 0, 0, 0, 0, 0];
  for (let k = 0; k < t.tris.length; k += 3) {
    const a = t.tris[k], b = t.tris[k + 1], c = t.tris[k + 2];
    tri[0] = V[2 * a]; tri[1] = V[2 * a + 1]; tri[2] = V[2 * b]; tri[3] = V[2 * b + 1]; tri[4] = V[2 * c]; tri[5] = V[2 * c + 1];
    const minX = Math.min(tri[0], tri[2], tri[4]), maxX = Math.max(tri[0], tri[2], tri[4]);
    const minZ = Math.min(tri[1], tri[3], tri[5]), maxZ = Math.max(tri[1], tri[3], tri[5]);
    const i0 = Math.floor(minX / cellM), i1 = Math.floor(maxX / cellM), j0 = Math.floor(minZ / cellM), j1 = Math.floor(maxZ / cellM);
    if (i0 === i1 && j0 === j1) { emitConvex(d, tri, st); continue; }
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        cellRect.x0 = i * cellM; cellRect.x1 = (i + 1) * cellM; cellRect.y0 = j * cellM; cellRect.y1 = (j + 1) * cellM;
        const piece = clipRingToRect(tri, cellRect);
        if (piece.length >= 6) emitConvex(d, piece, st);
      }
    }
  }
  return d.triangleCount - before;
}

function emitConvex(d: DrapeBuilder, poly: readonly number[], st: DrapeStyle): void {
  const n = poly.length / 2;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = poly[2 * i], z = poly[2 * i + 1];
    idx.push(d.vertex(x, z, st.lift(x, z), st.r, st.g, st.b));
  }
  for (let i = 1; i + 1 < n; i++) {
    if (st.drop && dropped(st, poly[0], poly[1], poly[2 * i], poly[2 * i + 1], poly[2 * i + 2], poly[2 * i + 3])) continue;
    d.triangleUp(idx[0], idx[i], idx[i + 1]);
  }
}

function dropped(st: DrapeStyle, ax: number, az: number, bx: number, bz: number, cx: number, cz: number): boolean {
  const f = st.drop!;
  const a = f(ax, az), b = f(bx, bz), c = f(cx, cz);
  return st.dropMode === 'all' ? a && b && c : a || b || c;
}

/**
 * Resample a polyline so that no step exceeds `stepM` (original vertices kept). Returns
 * stations with unit mitre normals (left of travel) and the mitre scale (1/cos of half the turn).
 */
export function ribbonStations(line: readonly number[], stepM: number): { x: number; z: number; nx: number; nz: number; s: number; dist: number }[] {
  const pts: number[] = [];
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i], az = line[i + 1], bx = line[i + 2], bz = line[i + 3];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) continue;
    const k = Math.max(1, Math.ceil(len / stepM));
    for (let j = 0; j < k; j++) pts.push(ax + ((bx - ax) * j) / k, az + ((bz - az) * j) / k);
  }
  if (line.length >= 4) pts.push(line[line.length - 2], line[line.length - 1]);
  const out: { x: number; z: number; nx: number; nz: number; s: number; dist: number }[] = [];
  const n = pts.length / 2;
  if (n < 2) return out;
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[2 * i], z = pts[2 * i + 1];
    if (i > 0) dist += Math.hypot(x - pts[2 * i - 2], z - pts[2 * i - 1]);
    const pi = Math.max(0, i - 1), ni = Math.min(n - 1, i + 1);
    let d0x = x - pts[2 * pi], d0z = z - pts[2 * pi + 1];
    let d1x = pts[2 * ni] - x, d1z = pts[2 * ni + 1] - z;
    const l0 = Math.hypot(d0x, d0z), l1 = Math.hypot(d1x, d1z);
    if (l0 > 1e-6) { d0x /= l0; d0z /= l0; } else { d0x = d1x / (l1 || 1); d0z = d1z / (l1 || 1); }
    if (l1 > 1e-6) { d1x /= l1; d1z /= l1; } else { d1x = d0x; d1z = d0z; }
    let tx = d0x + d1x, tz = d0z + d1z;
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-6) { tx = d1x; tz = d1z; } else { tx /= tl; tz /= tl; }
    // left of travel in (east, south): (dz, −dx)
    const nx = tz, nz = -tx;
    const cosHalf = nx * d1z - nz * d1x;
    const s = Math.min(2, 1 / Math.max(0.5, Math.abs(cosHalf)));
    out.push({ x, z, nx, nz, s, dist });
  }
  return out;
}

/** Drape a ribbon of half width `halfW` along a polyline (3 vertices per station). */
export function drapeRibbon(d: DrapeBuilder, line: readonly number[], halfW: number, stepM: number, st: DrapeStyle): number {
  const stations = ribbonStations(line, stepM);
  if (stations.length < 2) return 0;
  d.newScope();
  const before = d.triangleCount;
  let prev: [number, number, number] | null = null;
  let prevP: number[] = [];
  for (const s of stations) {
    const ox = s.nx * halfW * s.s, oz = s.nz * halfW * s.s;
    const lx = s.x + ox, lz = s.z + oz, rx = s.x - ox, rz = s.z - oz;
    const cur: [number, number, number] = [
      d.vertex(lx, lz, st.lift(lx, lz), st.r, st.g, st.b),
      d.vertex(s.x, s.z, st.lift(s.x, s.z), st.r, st.g, st.b),
      d.vertex(rx, rz, st.lift(rx, rz), st.r, st.g, st.b),
    ];
    const curP = [lx, lz, s.x, s.z, rx, rz];
    if (prev) {
      for (let k = 0; k < 2; k++) {
        const a = prev[k], b = prev[k + 1], c = cur[k], e = cur[k + 1];
        const pa = [prevP[2 * k], prevP[2 * k + 1]], pb = [prevP[2 * k + 2], prevP[2 * k + 3]];
        const pc = [curP[2 * k], curP[2 * k + 1]], pe = [curP[2 * k + 2], curP[2 * k + 3]];
        if (!(st.drop && dropped(st, pa[0], pa[1], pb[0], pb[1], pc[0], pc[1]))) d.triangleUp(a, b, c);
        if (!(st.drop && dropped(st, pb[0], pb[1], pe[0], pe[1], pc[0], pc[1]))) d.triangleUp(b, e, c);
      }
    }
    prev = cur;
    prevP = curP;
  }
  return d.triangleCount - before;
}

/** A flat square decal (e.g. a floodlight pool) with its own 0..1 UVs, 3×3 vertices so it follows gentle slopes. */
export function drapeDecal(d: DrapeBuilder, cx: number, cz: number, half: number, lift: number, r: number, g: number, b: number): void {
  const idx: number[] = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const u = i / 2, v = j / 2;
      idx.push(d.vertex(cx + (u * 2 - 1) * half, cz + (v * 2 - 1) * half, lift, r, g, b, u, v));
    }
  }
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const a = idx[j * 3 + i], bb = idx[j * 3 + i + 1], c = idx[(j + 1) * 3 + i], e = idx[(j + 1) * 3 + i + 1];
      d.triangleUp(a, bb, e);
      d.triangleUp(a, e, c);
    }
  }
}
