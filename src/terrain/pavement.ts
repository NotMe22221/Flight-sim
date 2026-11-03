/**
 * Pavement flattening: airport aprons, taxiway areas and taxiway centre lines (buffered to their
 * width) flattened to a target surface, as runways.ts does for runway strips.
 *
 * Applied in the terrain worker on the DEM grid *before* the runway flattening (a runway strip
 * wins where a taxiway reaches onto it, and its feather blends into the flattened pavement), so
 * the tile mesh, the HeightField (collision samples the mesh lattice) and every LOD sample the
 * same modified heights. The target is a plane per airport in geodetic height,
 * `h = h0 + dhdE·east + dhdN·north` in a local equirectangular frame at its anchor (src/world
 * fits it through the runway thresholds), so it never changes as tiles refine and is the same in
 * every tile: inside the flat zone (pavement + `shoulderM`) neighbouring tiles agree exactly.
 *
 * Outside the flat zone the override feathers back into the DEM over a width that grows with the
 * height difference (`featherMinM` … `featherMaxM`, at most `maxBankSlope` steep), so a deep cut
 * or fill becomes a bank, never a cliff.
 *
 * Everything here is a pure function of (lon, lat) and the DEM value at the pixel.
 */
import { smoothstep } from '../core/math';
import { tileBounds, tileToLonLat } from '../geo/mercator';
import { EARTH_RADIUS } from '../geo/wgs84';

const D2R = Math.PI / 180;
const M_PER_DEG = EARTH_RADIUS * D2R;

/** Target surface of an airport's pavement: a plane in (east, north, geodetic height) at an anchor. */
export interface PavementPlane {
  /** anchor (degrees) of the plane's local equirectangular frame */
  lat0: number;
  lon0: number;
  /** height at the anchor (m, DEM datum) */
  h0: number;
  /** slope towards east / north (m per m) */
  dhdE: number;
  dhdN: number;
}

/** One flattened pavement area (plain data: crosses the worker boundary). */
export interface PavementFlatteningSpec {
  /** stable identity (diffing in TerrainSystem.setPavement) */
  key: string;
  /** polygon rings `[lon, lat, lon, lat, …]` (degrees, open): rings[0] outer, the rest holes; [] for a line */
  rings: number[][];
  /** centre line `[lon, lat, …]` (taxiway / taxilane); [] for a polygon */
  line: number[];
  /** half width of a centre line's pavement (m) */
  halfWidthM: number;
  plane: PavementPlane;
  /** flat margin beyond the outline (m): covers the mesh triangles and DEM pixels that straddle it */
  shoulderM: number;
  /** feather width bounds (m) and the steepest bank it may create (m/m) */
  featherMinM: number;
  featherMaxM: number;
  maxBankSlope: number;
  /** lon/lat bounds of the geometry itself (degrees) */
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Defaults. Shoulder 15 m: a z15 mesh triangle (7.6 m quads, 10.7 m diagonal) touching the
 * pavement plus the bilinear footprint of its vertices (2.7 m) lies entirely in the flat zone.
 * Feather 80 m for small differences (≤ 13 m, at most 1.5·13/80 ≈ 25 %), widening to 160 m.
 */
export const PAVEMENT_SHOULDER_M = 15;
export const PAVEMENT_FEATHER_MIN_M = 80;
export const PAVEMENT_FEATHER_MAX_M = 160;
export const PAVEMENT_MAX_BANK_SLOPE = 0.25;
/** Tiles coarser than this skip pavement flattening (pixels ≥ 75 m: pavement is sub-pixel there). */
export const PAVEMENT_MIN_ZOOM = 11;
/** Long edges are split into pieces of at most this length (m) so splatting stays local. */
const PIECE_M = 64;

export interface PavementGeometry {
  /** polygon rings (lon/lat pairs), outer first */
  rings?: number[][];
  /** centre line (lon/lat pairs) and its pavement half width */
  line?: number[];
  halfWidthM?: number;
}

/** Build a spec (with bounds) from geometry, a plane and optional feather settings. Null for degenerate input. */
export function makePavementSpec(
  key: string, geom: PavementGeometry, plane: PavementPlane,
  opts: Partial<Pick<PavementFlatteningSpec, 'shoulderM' | 'featherMinM' | 'featherMaxM' | 'maxBankSlope'>> = {},
): PavementFlatteningSpec | null {
  const rings = (geom.rings ?? []).filter((r) => r.length >= 6 && r.every(Number.isFinite));
  const line = geom.line && geom.line.length >= 4 && geom.line.every(Number.isFinite) ? geom.line : [];
  if (rings.length === 0 && line.length === 0) return null;
  const pts = rings.length > 0 ? [rings[0]] : [line];
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const p of pts) {
    for (let i = 0; i + 1 < p.length; i += 2) {
      west = Math.min(west, p[i]); east = Math.max(east, p[i]);
      south = Math.min(south, p[i + 1]); north = Math.max(north, p[i + 1]);
    }
  }
  const finite = [plane.lat0, plane.lon0, plane.h0, plane.dhdE, plane.dhdN].every(Number.isFinite);
  if (!finite) return null;
  return {
    key,
    rings: rings.length > 0 ? rings : [],
    line: rings.length > 0 ? [] : line,
    halfWidthM: rings.length > 0 ? 0 : Math.max(0, geom.halfWidthM ?? 0),
    plane,
    shoulderM: Math.max(0, opts.shoulderM ?? PAVEMENT_SHOULDER_M),
    featherMinM: Math.max(1, opts.featherMinM ?? PAVEMENT_FEATHER_MIN_M),
    featherMaxM: Math.max(opts.featherMinM ?? PAVEMENT_FEATHER_MIN_M, opts.featherMaxM ?? PAVEMENT_FEATHER_MAX_M, 1),
    maxBankSlope: Math.max(0.01, opts.maxBankSlope ?? PAVEMENT_MAX_BANK_SLOPE),
    west, south, east, north,
  };
}

/** Target height (m) of a plane at (lon, lat). */
export function planeHeightAt(p: PavementPlane, lon: number, lat: number): number {
  const kx = M_PER_DEG * Math.cos(p.lat0 * D2R);
  return p.h0 + p.dhdE * (lon - p.lon0) * kx + p.dhdN * (lat - p.lat0) * M_PER_DEG;
}

/** Distance (m) from the geometry within which the spec changes heights. */
export function pavementReachM(s: PavementFlatteningSpec): number {
  return s.halfWidthM + s.shoulderM + s.featherMaxM;
}

/** Does the spec's feathered footprint touch the lon/lat box? */
function touchesBox(s: PavementFlatteningSpec, b: { west: number; south: number; east: number; north: number }): boolean {
  const reach = pavementReachM(s);
  const dLat = reach / M_PER_DEG;
  const dLon = reach / (M_PER_DEG * Math.max(0.01, Math.cos(Math.max(Math.abs(s.south), Math.abs(s.north)) * D2R)));
  return !(s.east + dLon < b.west || s.west - dLon > b.east || s.north + dLat < b.south || s.south - dLat > b.north);
}

/** Does tile (z, x, y) intersect any spec's feathered footprint? (tile invalidation) */
export function tileTouchesPavement(z: number, x: number, y: number, specs: readonly PavementFlatteningSpec[]): boolean {
  if (specs.length === 0 || z < PAVEMENT_MIN_ZOOM) return false;
  const b = tileBounds(x, y, z);
  for (const s of specs) if (touchesBox(s, b)) return true;
  return false;
}

/** The specs a load request for tile (z, x, y) needs (none below PAVEMENT_MIN_ZOOM). */
export function pavementForTile(z: number, x: number, y: number, specs: readonly PavementFlatteningSpec[]): PavementFlatteningSpec[] {
  if (specs.length === 0 || z < PAVEMENT_MIN_ZOOM) return [];
  const b = tileBounds(x, y, z);
  const out: PavementFlatteningSpec[] = [];
  for (const s of specs) if (touchesBox(s, b)) out.push(s);
  return out;
}

/** Indices [i0, i1] (inclusive, possibly empty when i0 > i1) of an ascending array within [lo, hi]. */
function rangeAsc(a: Float64Array, lo: number, hi: number, out: Int32Array): void {
  let l = 0, r = a.length;
  while (l < r) { const m = (l + r) >> 1; if (a[m] < lo) l = m + 1; else r = m; }
  const i0 = l;
  l = i0; r = a.length;
  while (l < r) { const m = (l + r) >> 1; if (a[m] <= hi) l = m + 1; else r = m; }
  out[0] = i0; out[1] = l - 1;
}

/** Same for a descending array (rows: latitude decreases southwards). */
function rangeDesc(a: Float64Array, lo: number, hi: number, out: Int32Array): void {
  let l = 0, r = a.length;
  while (l < r) { const m = (l + r) >> 1; if (a[m] > hi) l = m + 1; else r = m; }
  const j0 = l;
  l = j0; r = a.length;
  while (l < r) { const m = (l + r) >> 1; if (a[m] >= lo) l = m + 1; else r = m; }
  out[0] = j0; out[1] = l - 1;
}

/** Scratch state of one flattening pass over a tile grid. */
interface Pass {
  width: number;
  /** pixel centres in the current spec's local metres (east per column ascending, north per row descending) */
  px: Float64Array;
  py: Float64Array;
  /** signed distance (m) to the edge of the flat zone, negative inside; +∞ untouched */
  dflat: Float32Array;
  owner: Int32Array;
  range: Int32Array;
}

/** Pixels per side of a block in the distance search. */
const BLOCK = 8;

/** Segments of one plane anchor in its local metres: `[ax, ay, bx, by, offset, reach]` per piece, and the owning spec. */
class Segments {
  readonly data: number[] = [];
  readonly owner: number[] = [];
  /** add a segment, split into pieces of at most PIECE_M (tight per-block bounds) */
  add(ax: number, ay: number, bx: number, by: number, offset: number, reach: number, k: number): void {
    const pieces = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / PIECE_M));
    for (let q = 0; q < pieces; q++) {
      this.data.push(ax + ((bx - ax) * q) / pieces, ay + ((by - ay) * q) / pieces, ax + ((bx - ax) * (q + 1)) / pieces, ay + ((by - ay) * (q + 1)) / pieces, offset, reach);
      this.owner.push(k);
    }
  }
}

/**
 * Distance field of a set of segments: every pixel gets d = |p − seg| − offset of its nearest
 * segment (if that beats what it has). Segments are bucketed into 8×8-pixel blocks within their
 * reach; per block the candidates are sorted by a lower bound (the gap between their bounding box
 * and the block's) and each pixel stops at the first candidate whose bound cannot beat its best.
 */
function distanceField(P: Pass, S: Segments): void {
  const w = P.width, nb = Math.ceil(w / BLOCK), D = S.data, count = S.owner.length;
  if (count === 0) return;
  const buckets: (number[] | undefined)[] = new Array(nb * nb);
  const r = P.range;
  for (let q = 0; q < count; q++) {
    const o = q * 6, reach = D[o + 5];
    rangeAsc(P.px, Math.min(D[o], D[o + 2]) - reach, Math.max(D[o], D[o + 2]) + reach, r);
    if (r[0] > r[1]) continue;
    const bi0 = (r[0] / BLOCK) | 0, bi1 = (r[1] / BLOCK) | 0;
    rangeDesc(P.py, Math.min(D[o + 1], D[o + 3]) - reach, Math.max(D[o + 1], D[o + 3]) + reach, r);
    if (r[0] > r[1]) continue;
    const bj0 = (r[0] / BLOCK) | 0, bj1 = (r[1] / BLOCK) | 0;
    for (let bj = bj0; bj <= bj1; bj++) {
      for (let bi = bi0; bi <= bi1; bi++) {
        const b = bj * nb + bi;
        const list = buckets[b];
        if (list) list.push(q); else buckets[b] = [q];
      }
    }
  }
  const lb = new Float64Array(count);
  const byBound = (a: number, b: number): number => lb[a] - lb[b];
  for (let bj = 0; bj < nb; bj++) {
    for (let bi = 0; bi < nb; bi++) {
      const list = buckets[bj * nb + bi];
      if (!list) continue;
      const i0 = bi * BLOCK, i1 = Math.min(w, i0 + BLOCK) - 1, j0 = bj * BLOCK, j1 = Math.min(w, j0 + BLOCK) - 1;
      const rx0 = P.px[i0], rx1 = P.px[i1], ry0 = P.py[j1], ry1 = P.py[j0];
      for (const q of list) {
        const o = q * 6;
        const gx = Math.max(0, Math.min(D[o], D[o + 2]) - rx1, rx0 - Math.max(D[o], D[o + 2]));
        const gy = Math.max(0, Math.min(D[o + 1], D[o + 3]) - ry1, ry0 - Math.max(D[o + 1], D[o + 3]));
        lb[q] = Math.sqrt(gx * gx + gy * gy) - D[o + 4];
      }
      list.sort(byBound);
      const n = list.length;
      for (let j = j0; j <= j1; j++) {
        const yy = P.py[j], row = j * w;
        for (let i = i0; i <= i1; i++) {
          const p = row + i, xx = P.px[i];
          let best = P.dflat[p], who = P.owner[p];
          for (let c = 0; c < n; c++) {
            const q = list[c];
            if (lb[q] >= best) break;
            const o = q * 6;
            const x0 = D[o], y0 = D[o + 1], dx = D[o + 2] - x0, dy = D[o + 3] - y0, l2 = dx * dx + dy * dy;
            let t = l2 > 0 ? ((xx - x0) * dx + (yy - y0) * dy) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = xx - (x0 + t * dx), ey = yy - (y0 + t * dy);
            const v = Math.sqrt(ex * ex + ey * ey) - D[o + 4];
            if (v < best) { best = v; who = S.owner[q]; }
          }
          if (who !== P.owner[p] || best < P.dflat[p]) { P.dflat[p] = best; P.owner[p] = who; }
        }
      }
    }
  }
}

/** Fill the polygon interior (even-odd over all rings, so holes stay open) with −shoulder. */
function fillPolygon(P: Pass, k: number, rings: readonly Float64Array[], shoulder: number): void {
  let minY = Infinity, maxY = -Infinity;
  for (let n = 0; n < rings[0].length; n += 2) { minY = Math.min(minY, rings[0][n + 1]); maxY = Math.max(maxY, rings[0][n + 1]); }
  const r = P.range;
  rangeDesc(P.py, minY, maxY, r);
  const j0 = r[0], j1 = r[1];
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const yy = P.py[j];
    xs.length = 0;
    for (const ring of rings) {
      const m = ring.length;
      for (let a = 0, b = m - 2; a < m; b = a, a += 2) {
        const ya = ring[a + 1], yb = ring[b + 1];
        if ((ya > yy) === (yb > yy)) continue;
        xs.push(ring[a] + ((yy - ya) * (ring[b] - ring[a])) / (yb - ya));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((u, v) => u - v);
    const row = j * P.width;
    const c = P.range;
    for (let q = 0; q + 1 < xs.length; q += 2) {
      rangeAsc(P.px, xs[q], xs[q + 1], c);
      for (let i = c[0]; i <= c[1]; i++) {
        const p = row + i;
        if (-shoulder < P.dflat[p]) { P.dflat[p] = -shoulder; P.owner[p] = k; }
      }
    }
  }
}

/**
 * Apply pavement flattening in place to a tile's height grid (`width`², row 0 north, pixel
 * centres at +0.5). Returns the number of pixels modified. Tiles below PAVEMENT_MIN_ZOOM, or
 * missing every spec's feathered footprint, return 0 without touching the grid.
 */
export function applyPavementFlattening(
  heights: Float32Array, width: number, z: number, x: number, y: number,
  specs: readonly PavementFlatteningSpec[],
): number {
  const active = pavementForTile(z, x, y, specs);
  if (active.length === 0) return 0;
  const n = width * width;
  const lons = new Float64Array(width), lats = new Float64Array(width);
  for (let i = 0; i < width; i++) {
    lons[i] = tileToLonLat(x + (i + 0.5) / width, y, z).lon;
    lats[i] = tileToLonLat(x, y + (i + 0.5) / width, z).lat;
  }
  const P: Pass = {
    width, px: new Float64Array(width), py: new Float64Array(width),
    dflat: new Float32Array(n).fill(Infinity), owner: new Int32Array(n).fill(-1), range: new Int32Array(2),
  };
  // specs sharing a plane anchor share a local frame: their segments go through one distance search
  const groups = new Map<string, number[]>();
  for (let k = 0; k < active.length; k++) {
    const g = `${active[k].plane.lat0},${active[k].plane.lon0}`;
    const list = groups.get(g);
    if (list) list.push(k); else groups.set(g, [k]);
  }
  for (const members of groups.values()) {
    const pl = active[members[0]].plane;
    const kx = M_PER_DEG * Math.cos(pl.lat0 * D2R), ky = M_PER_DEG;
    for (let i = 0; i < width; i++) { P.px[i] = (lons[i] - pl.lon0) * kx; P.py[i] = (lats[i] - pl.lat0) * ky; }
    const local = (pts: readonly number[]): Float64Array => {
      const out = new Float64Array(pts.length);
      for (let i = 0; i + 1 < pts.length; i += 2) { out[i] = (pts[i] - pl.lon0) * kx; out[i + 1] = (pts[i + 1] - pl.lat0) * ky; }
      return out;
    };
    const segs = new Segments();
    for (const k of members) {
      const s = active[k];
      if (s.rings.length > 0) {
        const rings = s.rings.map(local);
        fillPolygon(P, k, rings, s.shoulderM);
        const reach = s.shoulderM + s.featherMaxM;
        for (const ring of rings) {
          const m = ring.length;
          for (let a = 0, b = m - 2; a < m; b = a, a += 2) segs.add(ring[b], ring[b + 1], ring[a], ring[a + 1], s.shoulderM, reach, k);
        }
      } else {
        const l = local(s.line);
        const off = s.halfWidthM + s.shoulderM;
        for (let a = 0; a + 3 < l.length; a += 2) segs.add(l[a], l[a + 1], l[a + 2], l[a + 3], off, off + s.featherMaxM, k);
      }
    }
    distanceField(P, segs);
  }
  let modified = 0;
  const kxs = active.map((s) => M_PER_DEG * Math.cos(s.plane.lat0 * D2R));
  for (let j = 0; j < width; j++) {
    const row = j * width;
    for (let i = 0; i < width; i++) {
      const p = row + i;
      const k = P.owner[p];
      if (k < 0) continue;
      const s = active[k], pl = s.plane;
      const d = P.dflat[p];
      const target = pl.h0 + pl.dhdE * (lons[i] - pl.lon0) * kxs[k] + pl.dhdN * (lats[j] - pl.lat0) * M_PER_DEG;
      const h = heights[p];
      if (d <= 0) { heights[p] = target; modified++; continue; }
      const delta = h - target;
      const feather = Math.min(s.featherMaxM, Math.max(s.featherMinM, (1.5 * Math.abs(delta)) / s.maxBankSlope));
      if (d >= feather) continue;
      heights[p] = h - delta * (1 - smoothstep(0, feather, d));
      modified++;
    }
  }
  return modified;
}
