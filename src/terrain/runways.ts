/**
 * Runway flattening (docs/research/03 §8.3).
 *
 * No DEM is flat under a runway (−3 m at Sion, +2 m at Half Moon Bay against the published
 * thresholds), so inside a strip around the threshold-to-threshold centreline the heights
 * are replaced by the linear interpolation between the two threshold elevations and
 * feathered back into the DEM over `featherM`. The same modified grid is what the
 * HeightField samples, so wheels and pixels agree by construction.
 */
import { smoothstep } from '../core/math';
import type { Runway } from '../core/types';
import { tileBounds, tileToLonLat } from '../geo/mercator';
import { EARTH_RADIUS } from '../geo/wgs84';

const D2R = Math.PI / 180;

export interface RunwayEnd {
  /** degrees */ lat: number;
  /** degrees */ lon: number;
  /** threshold elevation, metres (same datum as the DEM) */ elev: number;
}

export interface RunwayFlatteningSpec {
  a: RunwayEnd;
  b: RunwayEnd;
  /** half width of the fully flattened strip, metres (runway half width + shoulder margin) */
  halfWidthM: number;
  /** distance over which the override feathers into the DEM, metres */
  featherM: number;
}

/** Default shoulder added to the runway half width (m) and feather distance (m) per §8.3. */
export const RUNWAY_SHOULDER_M = 30;
export const RUNWAY_FEATHER_M = 150;

/** Build a flattening spec from a nav `Runway` (thresholds carry the elevations in `alt`). */
export function runwayFlatteningFromRunway(rw: Runway, shoulderM = RUNWAY_SHOULDER_M, featherM = RUNWAY_FEATHER_M): RunwayFlatteningSpec {
  return {
    a: { lat: rw.threshold.lat, lon: rw.threshold.lon, elev: rw.threshold.alt },
    b: { lat: rw.end.lat, lon: rw.end.lon, elev: rw.end.alt },
    halfWidthM: rw.widthM / 2 + shoulderM,
    featherM,
  };
}

/** Precomputed per-runway geometry in a local equirectangular frame at threshold A. */
interface RunwayLocal {
  spec: RunwayFlatteningSpec;
  /** metres per degree of longitude / latitude at A */
  kx: number; ky: number;
  /** unit direction A → B and length */
  dx: number; dy: number; length: number;
  /** lon/lat bounding box expanded by halfWidth + feather */
  west: number; east: number; south: number; north: number;
}

function prepare(spec: RunwayFlatteningSpec): RunwayLocal {
  const ky = EARTH_RADIUS * D2R;
  const kx = ky * Math.cos(spec.a.lat * D2R);
  const ex = (spec.b.lon - spec.a.lon) * kx, ny = (spec.b.lat - spec.a.lat) * ky;
  const length = Math.hypot(ex, ny) || 1;
  const reach = spec.halfWidthM + spec.featherM;
  const dLon = reach / kx, dLat = reach / ky;
  return {
    spec, kx, ky, dx: ex / length, dy: ny / length, length,
    west: Math.min(spec.a.lon, spec.b.lon) - dLon,
    east: Math.max(spec.a.lon, spec.b.lon) + dLon,
    south: Math.min(spec.a.lat, spec.b.lat) - dLat,
    north: Math.max(spec.a.lat, spec.b.lat) + dLat,
  };
}

/**
 * Flattening weight (0..1) and runway surface height at (lon, lat) for one prepared runway.
 * Returns weight 0 when the point is outside the feathered strip.
 */
function evaluate(r: RunwayLocal, lon: number, lat: number, out: Float64Array): void {
  const e = (lon - r.spec.a.lon) * r.kx, n = (lat - r.spec.a.lat) * r.ky;
  const s = e * r.dx + n * r.dy;                       // along-track from A
  const p = Math.abs(-e * r.dy + n * r.dx);            // cross-track
  const overrun = s < 0 ? -s : s > r.length ? s - r.length : 0;
  const lateral = p > r.spec.halfWidthM ? p - r.spec.halfWidthM : 0;
  const d = Math.hypot(overrun, lateral);
  if (d >= r.spec.featherM) { out[0] = 0; out[1] = 0; return; }
  const t = s <= 0 ? 0 : s >= r.length ? 1 : s / r.length;
  out[0] = 1 - smoothstep(0, r.spec.featherM, d);
  out[1] = r.spec.a.elev + (r.spec.b.elev - r.spec.a.elev) * t;
}

/**
 * Height override at (lon, lat): the flattened height if any runway strip covers the point
 * (blended with `demHeight` by the feather weight), otherwise `demHeight` unchanged.
 */
export function flattenedHeightAt(lon: number, lat: number, demHeight: number, runways: readonly RunwayFlatteningSpec[]): number {
  let h = demHeight;
  const tmp = scratch;
  for (const spec of runways) {
    const r = prepare(spec);
    if (lon < r.west || lon > r.east || lat < r.south || lat > r.north) continue;
    evaluate(r, lon, lat, tmp);
    if (tmp[0] > 0) h += (tmp[1] - h) * tmp[0];
  }
  return h;
}
const scratch = new Float64Array(2);

/**
 * Apply runway flattening in place to a tile's height grid (`width`×`width`, row 0 north,
 * pixel centres at +0.5). Returns the number of pixels modified. Tiles whose bounds miss
 * every runway's expanded bounding box return immediately without touching the grid.
 */
export function applyRunwayFlattening(
  heights: Float32Array,
  width: number,
  z: number, x: number, y: number,
  runways: readonly RunwayFlatteningSpec[],
): number {
  if (runways.length === 0) return 0;
  const b = tileBounds(x, y, z);
  const active: RunwayLocal[] = [];
  for (const spec of runways) {
    const r = prepare(spec);
    if (r.east < b.west || r.west > b.east || r.north < b.south || r.south > b.north) continue;
    active.push(r);
  }
  if (active.length === 0) return 0;
  const lons = new Float64Array(width), lats = new Float64Array(width);
  for (let i = 0; i < width; i++) {
    lons[i] = tileToLonLat(x + (i + 0.5) / width, y, z).lon;
    lats[i] = tileToLonLat(x, y + (i + 0.5) / width, z).lat;
  }
  const tmp = scratch;
  let modified = 0;
  for (const r of active) {
    for (let j = 0; j < width; j++) {
      const lat = lats[j];
      if (lat < r.south || lat > r.north) continue;
      const row = j * width;
      for (let i = 0; i < width; i++) {
        const lon = lons[i];
        if (lon < r.west || lon > r.east) continue;
        evaluate(r, lon, lat, tmp);
        if (tmp[0] <= 0) continue;
        const k = row + i;
        heights[k] += (tmp[1] - heights[k]) * tmp[0];
        modified++;
      }
    }
  }
  return modified;
}

/** Does tile (z, x, y) intersect any runway's feathered footprint? (used to invalidate tiles when runways change) */
export function tileTouchesRunways(z: number, x: number, y: number, runways: readonly RunwayFlatteningSpec[]): boolean {
  if (runways.length === 0) return false;
  const b = tileBounds(x, y, z);
  for (const spec of runways) {
    const r = prepare(spec);
    if (!(r.east < b.west || r.west > b.east || r.north < b.south || r.south > b.north)) return true;
  }
  return false;
}
