/**
 * Deterministic tree scattering inside wood / forest landcover, parks and gardens.
 *
 * Candidates come from a jittered grid (hash of the tile seed and the grid cell, so the same
 * tile always yields the same trees), clipped to each polygon by scanlines, and rejected where
 * an occupancy grid marks buildings, roads, airport pavement or an already placed tree.
 * The per-tile cap thins the grid uniformly; instances are shuffled so that drawing only the
 * first N (distance thinning) still covers the whole tile evenly.
 */
import { ByteList, FloatList } from './meshBuilder';
import type { TreesData } from './protocol';
import { distToSegmentSq, pointInPolygon, ringBounds, signedArea } from './polygon';
import { hash01, hash2 } from './tileMath';

export type TreeAreaKind = 'forest' | 'park' | 'garden' | 'scrub';

export interface TreeArea {
  outer: number[];
  holes: number[][];
  kind: TreeAreaKind;
  /** fraction of conifers 0..1 */
  conifer: number;
}

/** Spacing multipliers relative to the forest spacing. */
export const AREA_SPACING: Record<TreeAreaKind, number> = { forest: 1, park: 2.6, garden: 3.6, scrub: 2.2 };

/** Boolean occupancy raster over the tile (local metres). */
export class OccupancyGrid {
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;

  constructor(x0: number, z0: number, x1: number, z1: number, cell = 3) {
    this.cell = cell;
    this.x0 = x0; this.z0 = z0;
    this.w = Math.max(1, Math.ceil((x1 - x0) / cell));
    this.h = Math.max(1, Math.ceil((z1 - z0) / cell));
    this.data = new Uint8Array(this.w * this.h);
  }

  private ci(x: number): number { return Math.floor((x - this.x0) / this.cell); }
  private cj(z: number): number { return Math.floor((z - this.z0) / this.cell); }

  occupied(x: number, z: number): boolean {
    const i = this.ci(x), j = this.cj(z);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return true;
    return this.data[j * this.w + i] !== 0;
  }

  mark(x: number, z: number): void {
    const i = this.ci(x), j = this.cj(z);
    if (i >= 0 && j >= 0 && i < this.w && j < this.h) this.data[j * this.w + i] = 1;
  }

  /** Fill a polygon (cell centres inside, even-odd) grown by `margin` metres along its edges. */
  fillPolygon(outer: readonly number[], holes: readonly (readonly number[])[], margin = 0): void {
    const rings = [outer, ...holes];
    const b = ringBounds(outer);
    const j0 = Math.max(0, this.cj(b.y0)), j1 = Math.min(this.h - 1, this.cj(b.y1));
    const xs: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const z = this.z0 + (j + 0.5) * this.cell;
      xs.length = 0;
      for (const r of rings) crossings(r, z, xs);
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - this.x0) / this.cell - 0.5)), i1 = Math.min(this.w - 1, Math.floor((xs[k + 1] - this.x0) / this.cell - 0.5));
        for (let i = i0; i <= i1; i++) this.data[j * this.w + i] = 1;
      }
    }
    if (margin > 0) for (const r of rings) this.strokeRing(r, margin);
  }

  strokeRing(ring: readonly number[], halfW: number): void {
    const n = ring.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) this.strokeSegment(ring[j], ring[j + 1], ring[i], ring[i + 1], halfW);
  }

  strokeLine(line: readonly number[], halfW: number): void {
    for (let i = 0; i + 3 < line.length; i += 2) this.strokeSegment(line[i], line[i + 1], line[i + 2], line[i + 3], halfW);
  }

  strokeSegment(ax: number, az: number, bx: number, bz: number, halfW: number): void {
    const i0 = Math.max(0, this.ci(Math.min(ax, bx) - halfW)), i1 = Math.min(this.w - 1, this.ci(Math.max(ax, bx) + halfW));
    const j0 = Math.max(0, this.cj(Math.min(az, bz) - halfW)), j1 = Math.min(this.h - 1, this.cj(Math.max(az, bz) + halfW));
    const r2 = (halfW + this.cell * 0.5) ** 2;
    for (let j = j0; j <= j1; j++) {
      const z = this.z0 + (j + 0.5) * this.cell;
      for (let i = i0; i <= i1; i++) {
        const x = this.x0 + (i + 0.5) * this.cell;
        if (distToSegmentSq(x, z, ax, az, bx, bz) <= r2) this.data[j * this.w + i] = 1;
      }
    }
  }
}

/** x coordinates where a horizontal line z crosses the ring's edges. */
function crossings(ring: readonly number[], z: number, out: number[]): void {
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const zi = ring[i + 1], zj = ring[j + 1];
    if ((zi > z) !== (zj > z)) out.push(ring[i] + ((z - zi) * (ring[j] - ring[i])) / (zj - zi));
  }
}

export interface ScatterOptions {
  maxTrees: number;
  spacingM: number;
  seed: number;
}

interface TreeRec { x: number; z: number; h: number; rot: number; conifer: boolean; r: number; g: number; b: number }

/** Scatter trees over the areas; returns null when none fit. */
export function scatterTrees(areas: readonly TreeArea[], occ: OccupancyGrid | null, opts: ScatterOptions): TreesData | null {
  if (areas.length === 0 || opts.maxTrees <= 0) return null;
  let expected = 0;
  for (const a of areas) {
    const area = Math.abs(signedArea(a.outer)) - a.holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
    const sp = opts.spacingM * AREA_SPACING[a.kind];
    expected += Math.max(0, area) / (sp * sp);
  }
  const thin = expected > opts.maxTrees ? Math.sqrt(expected / opts.maxTrees) : 1;
  const trees: TreeRec[] = [];
  const xs: number[] = [];
  // forests first so parks inside forests do not double up (occupancy marks placed trees)
  const order = areas.slice().sort((p, q) => AREA_SPACING[p.kind] - AREA_SPACING[q.kind]);
  for (const a of order) {
    const sp = opts.spacingM * AREA_SPACING[a.kind] * thin;
    const kindSeed = hash2(opts.seed, a.kind.length * 977 + Math.round(sp * 10));
    const b = ringBounds(a.outer);
    const rings = [a.outer, ...a.holes];
    const j0 = Math.floor(b.y0 / sp), j1 = Math.floor(b.y1 / sp);
    for (let j = j0; j <= j1 && trees.length < opts.maxTrees; j++) {
      const zRow = (j + 0.5) * sp;
      xs.length = 0;
      for (const r of rings) crossings(r, zRow, xs);
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length && trees.length < opts.maxTrees; k += 2) {
        const i0 = Math.ceil(xs[k] / sp - 0.5), i1 = Math.floor(xs[k + 1] / sp - 0.5);
        for (let i = i0; i <= i1 && trees.length < opts.maxTrees; i++) {
          const hsh = hash2(kindSeed ^ (i * 73856093), j * 19349663);
          // forest edges are ragged: skip a few candidates at random
          if (a.kind !== 'forest' && (hsh & 0xff) < 40) continue;
          const x = (i + 0.5) * sp + (hash01(hsh, 1) - 0.5) * sp * 0.85;
          const z = zRow + (hash01(hsh, 2) - 0.5) * sp * 0.85;
          if (!pointInPolygon(x, z, a.outer, a.holes)) continue;
          if (occ) {
            if (occ.occupied(x, z)) continue;
            occ.mark(x, z);
          }
          trees.push(makeTree(a, x, z, hsh));
        }
      }
    }
  }
  if (trees.length === 0) return null;
  // deterministic shuffle so a prefix is an even subset
  let s = opts.seed >>> 0;
  for (let i = trees.length - 1; i > 0; i--) {
    s = hash2(s, i);
    const k = s % (i + 1);
    const t = trees[i]; trees[i] = trees[k]; trees[k] = t;
  }
  const con = new FloatList(), conC = new ByteList(), brd = new FloatList(), brdC = new ByteList();
  for (const t of trees) {
    const f = t.conifer ? con : brd, c = t.conifer ? conC : brdC;
    f.push(t.x); f.push(t.z); f.push(t.h); f.push(t.rot);
    c.push3(t.r, t.g, t.b);
  }
  return { conifer: con.finish(), coniferColor: conC.finish(), broadleaf: brd.finish(), broadleafColor: brdC.finish(), count: trees.length };
}

function makeTree(a: TreeArea, x: number, z: number, hsh: number): TreeRec {
  const conifer = hash01(hsh, 3) < a.conifer;
  const u = hash01(hsh, 4);
  let h: number;
  switch (a.kind) {
    case 'forest': h = conifer ? 11 + u * 13 : 8 + u * 10; break;
    case 'park': h = conifer ? 9 + u * 9 : 7 + u * 8; break;
    case 'garden': h = conifer ? 7 + u * 7 : 5 + u * 7; break;
    default: h = 3 + u * 5;
  }
  // colour multiplier: greens from olive to blue-green, a few autumn-ish yellows for broadleaf
  const v = hash01(hsh, 5), w = hash01(hsh, 6);
  let r = 200 + v * 55, g = 210 + w * 45, b = 180 + v * 50;
  if (!conifer && w > 0.92) { r = 255; g = 235; b = 150; }
  return { x, z, h, rot: hash01(hsh, 7) * Math.PI * 2, conifer, r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}
