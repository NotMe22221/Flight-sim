/**
 * Building extrusion: footprint walls (outward normals, storey-scaled window UVs), flat roofs,
 * and hip or gable roofs for small residential buildings. Everything is merged into three
 * meshes per tile (windowed walls, plain walls, roofs), ordered most important first so the
 * main thread can hide small buildings with a draw range.
 */
import { BUILDING_SAMPLES, type BuildingsData } from './protocol';
import { MeshBuilder } from './meshBuilder';
import { orientedBox, ringCentroid, signedArea, triangulatePolygon } from './polygon';
import { hash01, hash2 } from './tileMath';

/** Window cells per texture repeat (both directions); see materials.ts. */
export const FACADE_CELLS = 8;
/** Walls start this far below the sampled base so slopes never show a gap (m). */
export const WALL_SKIRT_M = 1.5;
/** Pitched roofs only for buildings up to this height (m). */
export const PITCHED_MAX_HEIGHT_M = 12;

export interface BuildingInput {
  /** exterior ring, local metres (x east, y south), positive signedArea */
  outer: number[];
  /** holes (negative signedArea) */
  holes: number[][];
  /** per ring vertex: bit set when the vertex lies on the tile edge (walls between two such vertices on the same edge are skipped) */
  outerEdge?: Uint8Array;
  holesEdge?: Uint8Array[];
  height: number;
  minHeight: number;
  /** linear RGB 0..1 from the OSM colour, or null */
  colour: [number, number, number] | null;
  /** stable id (OSM id or index) for deterministic variation */
  id: number;
}

export type BuildingKind = 'house' | 'windowed' | 'plain';

/** sRGB palette entries → linear on use. */
const WALLS_RES: readonly [number, number, number][] = [
  [0.86, 0.81, 0.71], [0.9, 0.87, 0.79], [0.79, 0.78, 0.75], [0.92, 0.91, 0.88], [0.87, 0.82, 0.66],
  [0.74, 0.55, 0.45], [0.64, 0.41, 0.33], [0.73, 0.77, 0.8], [0.82, 0.76, 0.68], [0.7, 0.66, 0.58],
];
const WALLS_TALL: readonly [number, number, number][] = [
  [0.72, 0.73, 0.74], [0.62, 0.64, 0.66], [0.5, 0.55, 0.6], [0.8, 0.75, 0.64], [0.84, 0.84, 0.82], [0.58, 0.6, 0.62],
];
const WALLS_PLAIN: readonly [number, number, number][] = [
  [0.82, 0.82, 0.8], [0.88, 0.88, 0.86], [0.71, 0.75, 0.79], [0.83, 0.79, 0.7], [0.66, 0.67, 0.67],
];
const ROOFS_FLAT: readonly [number, number, number][] = [
  [0.56, 0.56, 0.55], [0.4, 0.4, 0.42], [0.7, 0.7, 0.68], [0.5, 0.47, 0.43], [0.47, 0.49, 0.46], [0.62, 0.61, 0.58],
];
const ROOFS_PITCHED: readonly [number, number, number][] = [
  [0.6, 0.33, 0.24], [0.44, 0.31, 0.24], [0.33, 0.33, 0.35], [0.37, 0.39, 0.43], [0.53, 0.29, 0.21], [0.42, 0.4, 0.37],
];

const toLin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toByte = (c: number): number => Math.max(0, Math.min(255, Math.round(c * 255)));

/** Classify a footprint: pitched-roof house, windowed building or plain (warehouse / hangar). */
export function classifyBuilding(area: number, height: number, minHeight: number, holes: number, fillRatio: number, pitched: boolean): BuildingKind {
  if (pitched && minHeight <= 0 && holes === 0 && height <= PITCHED_MAX_HEIGHT_M && area >= 30 && area <= 450 && fillRatio >= 0.82) return 'house';
  if ((area > 1500 && height <= 22) || (area > 400 && height < 4.5)) return 'plain';
  return 'windowed';
}

interface Prepared {
  input: BuildingInput;
  area: number;
  kind: BuildingKind;
  importance: number;
  big: boolean;
}

export interface BuildingsOptions {
  maxTriangles: number;
  pitchedRoofs: boolean;
  /** buildings at least this tall (m) or this large (m²) are "big" (kept at distance) */
  bigHeightM?: number;
  bigAreaM2?: number;
}

/** Extrude all buildings of a tile. */
export function buildBuildings(inputs: readonly BuildingInput[], opts: BuildingsOptions): BuildingsData | null {
  const bigH = opts.bigHeightM ?? 15, bigA = opts.bigAreaM2 ?? 600;
  const prepared: Prepared[] = [];
  for (const b of inputs) {
    if (b.outer.length < 6 || !(b.height > b.minHeight)) continue;
    const area = Math.abs(signedArea(b.outer)) - b.holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
    if (!(area > 1)) continue;
    const box = orientedBox(b.outer);
    const fill = box.area > 0 ? area / box.area : 0;
    const kind = classifyBuilding(area, b.height, b.minHeight, b.holes.length, fill, opts.pitchedRoofs);
    const importance = b.height * Math.sqrt(area);
    prepared.push({ input: b, area, kind, importance, big: b.height >= bigH || area >= bigA });
  }
  if (prepared.length === 0) return null;
  prepared.sort((p, q) => (p.big === q.big ? q.importance - p.importance : p.big ? -1 : 1));

  const walls = new MeshBuilder(true, true, 4096);
  const plain = new MeshBuilder(true, true, 1024);
  const roofs = new MeshBuilder(true, true, 2048);
  const ranges: number[] = [];
  const samples: number[] = [];
  const centroids: number[] = [];
  const bigIndex = new Uint32Array(3);
  let bigDone = false;
  let count = 0;
  for (const p of prepared) {
    if (!p.big && !bigDone) { bigIndex[0] = walls.indexCount; bigIndex[1] = plain.indexCount; bigIndex[2] = roofs.indexCount; bigDone = true; }
    const tris = walls.triangleCount + plain.triangleCount + roofs.triangleCount;
    if (tris >= opts.maxTriangles) break;
    const w0 = walls.vertexCount, p0 = plain.vertexCount, r0 = roofs.vertexCount;
    const wi0 = walls.indexCount, pi0 = plain.indexCount, ri0 = roofs.indexCount;
    const ok = emitBuilding(p, p.kind === 'plain' ? plain : walls, roofs);
    if (!ok) { rollback(walls, w0, wi0); rollback(plain, p0, pi0); rollback(roofs, r0, ri0); continue; }
    ranges.push(w0, walls.vertexCount - w0, p0, plain.vertexCount - p0, r0, roofs.vertexCount - r0);
    const c = ringCentroid(p.input.outer);
    centroids.push(c.x, c.y);
    pushSamples(p.input.outer, c.x, c.y, samples);
    count++;
  }
  if (!bigDone) { bigIndex[0] = walls.indexCount; bigIndex[1] = plain.indexCount; bigIndex[2] = roofs.indexCount; }
  if (count === 0) return null;
  return {
    walls: walls.finish(),
    plain: plain.finish(),
    roofs: roofs.finish(),
    ranges: Uint32Array.from(ranges),
    samples: Float32Array.from(samples),
    centroids: Float32Array.from(centroids),
    bigIndexCount: bigIndex,
    count,
  };
}

function rollback(m: MeshBuilder, v: number, i: number): void { m.vertexCount = v; m.indexCount = i; }

/** Centroid plus the oriented box corners pulled 15 % inward. */
function pushSamples(outer: number[], cx: number, cy: number, out: number[]): void {
  const box = orientedBox(outer);
  out.push(cx, cy);
  const wx = -box.uy, wy = box.ux;
  const L = box.halfLen * 0.85, W = box.halfWid * 0.85;
  const corners = [[L, W], [L, -W], [-L, -W], [-L, W]];
  for (let k = 0; k < BUILDING_SAMPLES - 1; k++) {
    const [a, b] = corners[k % 4];
    out.push(box.cx + box.ux * a + wx * b, box.cy + box.uy * a + wy * b);
  }
}

function wallColour(p: Prepared, seed: number): [number, number, number] {
  const c = p.input.colour;
  if (c) {
    // muted OSM colour: 75 % OSM, 25 % neutral grey
    return [c[0] * 0.75 + 0.12, c[1] * 0.75 + 0.12, c[2] * 0.75 + 0.12];
  }
  const pal = p.kind === 'plain' ? WALLS_PLAIN : p.input.height > 25 ? WALLS_TALL : WALLS_RES;
  const s = pal[seed % pal.length];
  const jitter = 0.94 + 0.12 * hash01(seed, 7);
  return [toLin(s[0] * jitter), toLin(s[1] * jitter), toLin(s[2] * jitter)];
}

function roofColour(p: Prepared, seed: number, pitched: boolean): [number, number, number] {
  const pal = pitched ? ROOFS_PITCHED : ROOFS_FLAT;
  const s = pal[(seed >>> 4) % pal.length];
  const jitter = 0.9 + 0.2 * hash01(seed, 11);
  return [toLin(s[0] * jitter), toLin(s[1] * jitter), toLin(s[2] * jitter)];
}

function emitBuilding(p: Prepared, wallMesh: MeshBuilder, roofs: MeshBuilder): boolean {
  const b = p.input;
  const seed = hash2(b.id | 0, Math.round(b.outer[0] * 10) ^ Math.round(b.outer[1] * 10));
  const tall = b.height > 25;
  const cellW = tall ? 2.2 : 3.2;
  const storeyH = tall ? 3.6 : 3.0;
  const uOff = Math.floor(hash01(seed, 1) * FACADE_CELLS) / FACADE_CELLS;
  const vOff = Math.floor(hash01(seed, 2) * FACADE_CELLS) / FACADE_CELLS;
  const wc = wallColour(p, seed);
  const wr = toByte(wc[0]), wg = toByte(wc[1]), wb = toByte(wc[2]);
  const bottom = b.minHeight > 0 ? b.minHeight : -WALL_SKIRT_M;

  if (p.kind === 'house') {
    const pitchedOk = emitPitched(p, seed, wallMesh, roofs, [wr, wg, wb], cellW, storeyH, uOff, vOff);
    if (pitchedOk) return true;
  }
  emitWalls(wallMesh, b.outer, b.outerEdge, bottom, b.height, cellW, storeyH, uOff, vOff, wr, wg, wb);
  b.holes.forEach((h, i) => emitWalls(wallMesh, h, b.holesEdge?.[i], bottom, b.height, cellW, storeyH, uOff, vOff, wr, wg, wb));
  const rc = roofColour(p, seed, false);
  if (!emitFlat(roofs, b.outer, b.holes, b.height, 1, toByte(rc[0]), toByte(rc[1]), toByte(rc[2]))) return false;
  if (b.minHeight > 0) emitFlat(roofs, b.outer, b.holes, b.minHeight, -1, toByte(rc[0] * 0.6), toByte(rc[1] * 0.6), toByte(rc[2] * 0.6));
  return true;
}

/** Vertical wall quads along a ring (outward normals; edges along the tile border skipped). */
export function emitWalls(m: MeshBuilder, ring: readonly number[], edge: Uint8Array | undefined, y0: number, y1: number,
  cellW: number, storeyH: number, uOff: number, vOff: number, r: number, g: number, bl: number): void {
  const n = ring.length / 2;
  const v0 = y0 / (storeyH * FACADE_CELLS) + vOff, v1 = y1 / (storeyH * FACADE_CELLS) + vOff;
  let u = uOff;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (edge && (edge[i] & edge[j]) !== 0) continue;
    const ax = ring[2 * i], az = ring[2 * i + 1], bx = ring[2 * j], bz = ring[2 * j + 1];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    // outward normal of a clockwise-from-above exterior ring (holes face into the courtyard)
    const nx = dz / len, nz = -dx / len;
    const cells = len < 1.6 ? 0.15 : Math.max(1, Math.round(len / cellW));
    const u0 = u, u1 = u + cells / FACADE_CELLS;
    u = len < 1.6 ? u : u1;
    const ia = m.vertex(ax, y0, az, nx, 0, nz, u0, v0, r, g, bl);
    const ib = m.vertex(bx, y0, bz, nx, 0, nz, u1, v0, r, g, bl);
    const ibt = m.vertex(bx, y1, bz, nx, 0, nz, u1, v1, r, g, bl);
    const iat = m.vertex(ax, y1, az, nx, 0, nz, u0, v1, r, g, bl);
    // counter-clockwise seen from outside: B_bottom, A_bottom, A_top / B_bottom, A_top, B_top
    m.triangle(ib, ia, iat);
    m.triangle(ib, iat, ibt);
  }
}

/** Flat cap at height y facing up (dir 1) or down (dir −1). Roof UVs are planar, 1 repeat per 24 m. */
export function emitFlat(m: MeshBuilder, outer: readonly number[], holes: readonly (readonly number[])[], y: number, dir: 1 | -1, r: number, g: number, b: number): boolean {
  const t = triangulatePolygon(outer, holes);
  if (t.tris.length === 0) return false;
  const base = m.vertexCount;
  for (let i = 0; i < t.verts.length; i += 2) m.vertex(t.verts[i], y, t.verts[i + 1], 0, dir, 0, t.verts[i] / 24, t.verts[i + 1] / 24, r, g, b);
  for (let i = 0; i < t.tris.length; i += 3) {
    if (dir === 1) m.triangle(base + t.tris[i], base + t.tris[i + 1], base + t.tris[i + 2]);
    else m.triangle(base + t.tris[i], base + t.tris[i + 2], base + t.tris[i + 1]);
  }
  return true;
}

type V3 = [number, number, number];

/** One flat-shaded triangle whose normal is made to agree with `hint` (winding flipped if needed). */
export function emitFacet(m: MeshBuilder, a: V3, b: V3, c: V3, hint: V3, uvScale: number, r: number, g: number, bl: number,
  uvFn?: (p: V3) => [number, number]): void {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-9) return;
  nx /= l; ny /= l; nz /= l;
  let p = a, q = b, s = c;
  if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) { nx = -nx; ny = -ny; nz = -nz; q = c; s = b; }
  const uv = uvFn ?? ((v: V3): [number, number] => [v[0] / uvScale, v[2] / uvScale]);
  const [pu, pv] = uv(p), [qu, qv] = uv(q), [su, sv] = uv(s);
  const i0 = m.vertex(p[0], p[1], p[2], nx, ny, nz, pu, pv, r, g, bl);
  const i1 = m.vertex(q[0], q[1], q[2], nx, ny, nz, qu, qv, r, g, bl);
  const i2 = m.vertex(s[0], s[1], s[2], nx, ny, nz, su, sv, r, g, bl);
  m.triangle(i0, i1, i2);
}

/** Hip or gable roof over the footprint's oriented box; walls up to the eaves. */
function emitPitched(p: Prepared, seed: number, wallMesh: MeshBuilder, roofs: MeshBuilder, wc: V3, cellW: number, storeyH: number, uOff: number, vOff: number): boolean {
  const b = p.input;
  const box = orientedBox(b.outer);
  if (box.halfWid < 1.5 || box.halfLen < 1.5) return false;
  const pitch = (28 + 14 * hash01(seed, 3)) * (Math.PI / 180);
  const roofH = Math.max(1.2, Math.min(box.halfWid * Math.tan(pitch), b.height * 0.45));
  const eave = b.height - roofH;
  if (eave < 2.2) return false;
  const gable = box.halfLen / box.halfWid > 1.6 ? hash01(seed, 4) < 0.75 : hash01(seed, 4) < 0.4;
  emitWalls(wallMesh, b.outer, b.outerEdge, -WALL_SKIRT_M, eave, cellW, storeyH, uOff, vOff, wc[0], wc[1], wc[2]);
  const rc = roofColour(p, seed, true);
  const rr = toByte(rc[0]), rg = toByte(rc[1]), rb = toByte(rc[2]);
  const ux = box.ux, uz = box.uy, wx = -box.uy, wz = box.ux;
  const over = 0.35;
  const L = box.halfLen + (gable ? 0.1 : over), W = box.halfWid + over;
  // eaves drop a little with the overhang so the slope stays continuous
  const yE = eave - over * Math.tan(pitch);
  const yR = eave + roofH;
  const P = (a: number, c: number, y: number): V3 => [box.cx + ux * a + wx * c, y, box.cy + uz * a + wz * c];
  const sideA: V3 = [wx, 1, wz], sideB: V3 = [-wx, 1, -wz];
  if (gable) {
    const r0 = P(-L, 0, yR), r1 = P(L, 0, yR);
    const a0 = P(-L, W, yE), a1 = P(L, W, yE), b0 = P(-L, -W, yE), b1 = P(L, -W, yE);
    emitFacet(roofs, a0, a1, r1, sideA, 6, rr, rg, rb); emitFacet(roofs, a0, r1, r0, sideA, 6, rr, rg, rb);
    emitFacet(roofs, b0, r1, b1, sideB, 6, rr, rg, rb); emitFacet(roofs, b0, r0, r1, sideB, 6, rr, rg, rb);
    // gable end triangles in the wall material (plain strip of the facade texture)
    const endUv = (v: V3): [number, number] => [uOff + 0.02, (v[1] / (storeyH * FACADE_CELLS)) + vOff];
    const Lw = box.halfLen;
    const g0a = P(-Lw, box.halfWid, eave), g0b = P(-Lw, -box.halfWid, eave), g0r = P(-Lw, 0, yR);
    const g1a = P(Lw, box.halfWid, eave), g1b = P(Lw, -box.halfWid, eave), g1r = P(Lw, 0, yR);
    emitFacet(wallMesh, g0a, g0b, g0r, [-ux, 0, -uz], 1, wc[0], wc[1], wc[2], endUv);
    emitFacet(wallMesh, g1a, g1b, g1r, [ux, 0, uz], 1, wc[0], wc[1], wc[2], endUv);
  } else {
    const ridge = Math.max(0, L - W);
    const r0 = P(-ridge, 0, yR), r1 = P(ridge, 0, yR);
    const a0 = P(-L, W, yE), a1 = P(L, W, yE), b0 = P(-L, -W, yE), b1 = P(L, -W, yE);
    emitFacet(roofs, a0, a1, r1, sideA, 6, rr, rg, rb);
    if (ridge > 0.01) emitFacet(roofs, a0, r1, r0, sideA, 6, rr, rg, rb);
    emitFacet(roofs, b1, b0, r0, sideB, 6, rr, rg, rb);
    if (ridge > 0.01) emitFacet(roofs, b1, r0, r1, sideB, 6, rr, rg, rb);
    emitFacet(roofs, a0, r0, b0, [-ux, 1, -uz], 6, rr, rg, rb);
    emitFacet(roofs, a1, b1, r1, [ux, 1, uz], 6, rr, rg, rb);
  }
  // underside of the eaves so the roof is closed from below
  const c0 = P(-L, W, yE), c1 = P(L, W, yE), c2 = P(L, -W, yE), c3 = P(-L, -W, yE);
  const dr = toByte(rc[0] * 0.5), dg = toByte(rc[1] * 0.5), db = toByte(rc[2] * 0.5);
  emitFacet(roofs, c0, c1, c2, [0, -1, 0], 6, dr, dg, db);
  emitFacet(roofs, c0, c2, c3, [0, -1, 0], 6, dr, dg, db);
  return true;
}
