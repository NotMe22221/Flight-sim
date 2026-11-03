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

/** Splat one segment (local metres): pixels within `reach` get d = |p − seg| − offset if smaller. */
function splatSegment(P: Pass, k: number, ax: number, ay: number, bx: number, by: number, offset: number, reach: number): void {
  const len = Math.hypot(bx - ax, by - ay);
  const pieces = Math.max(1, Math.ceil(len / PIECE_M));
  const r = P.range;
  for (let q = 0; q < pieces; q++) {
    const x0 = ax + ((bx - ax) * q) / pieces, y0 = ay + ((by - ay) * q) / pieces;
    const x1 = ax + ((bx - ax) * (q + 1)) / pieces, y1 = ay + ((by - ay) * (q + 1)) / pieces;
    rangeAsc(P.px, Math.min(x0, x1) - reach, Math.max(x0, x1) + reach, r);
    const i0 = r[0], i1 = r[1];
    if (i0 > i1) continue;
    rangeDesc(P.py, Math.min(y0, y1) - reach, Math.max(y0, y1) + reach, r);
    const j0 = r[0], j1 = r[1];
    if (j0 > j1) continue;
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
    const reach2 = reach * reach; // raw distances beyond `reach` are past the widest feather
    for (let j = j0; j <= j1; j++) {
      const yy = P.py[j];
      const row = j * P.width;
      for (let i = i0; i <= i1; i++) {
        const p = row + i;
        const cur = P.dflat[p];
        if (cur <= -offset) continue; // d − offset ≥ −offset cannot beat it
        const xx = P.px[i];
        let t = l2 > 0 ? ((xx - x0) * dx + (yy - y0) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = xx - (x0 + t * dx), ey = yy - (y0 + t * dy);
        const d2 = ex * ex + ey * ey;
        if (d2 > reach2) continue;
        const lim = cur + offset; // raw distance to beat (+∞ when untouched)
        if (lim < Infinity && d2 >= lim * lim) continue;
        const v = Math.sqrt(d2) - offset;
        if (v < cur) { P.dflat[p] = v; P.owner[p] = k; }
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
  for (let k = 0; k < active.length; k++) {
    const s = active[k];
    const kx = M_PER_DEG * Math.cos(s.plane.lat0 * D2R), ky = M_PER_DEG;
    for (let i = 0; i < width; i++) { P.px[i] = (lons[i] - s.plane.lon0) * kx; P.py[i] = (lats[i] - s.plane.lat0) * ky; }
    const local = (pts: readonly number[]): Float64Array => {
      const out = new Float64Array(pts.length);
      for (let i = 0; i + 1 < pts.length; i += 2) { out[i] = (pts[i] - s.plane.lon0) * kx; out[i + 1] = (pts[i + 1] - s.plane.lat0) * ky; }
      return out;
    };
    const reach = s.shoulderM + s.featherMaxM;
    if (s.rings.length > 0) {
      const rings = s.rings.map(local);
      fillPolygon(P, k, rings, s.shoulderM);
      for (const ring of rings) {
        const m = ring.length;
        for (let a = 0, b = m - 2; a < m; b = a, a += 2) splatSegment(P, k, ring[b], ring[b + 1], ring[a], ring[a + 1], s.shoulderM, reach);
      }
    } else {
      const l = local(s.line);
      const off = s.halfWidthM + s.shoulderM;
      for (let a = 0; a + 3 < l.length; a += 2) splatSegment(P, k, l[a], l[a + 1], l[a + 2], l[a + 3], off, off + s.featherMaxM);
    }
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
