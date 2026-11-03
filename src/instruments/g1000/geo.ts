/**
 * Minimal spherical geodesy for the G1000 displays (sphere R = 6 371 008.8 m, docs/research/05
 * §4.1): great-circle distance for CDI scaling and a local equirectangular projection for the
 * moving map. Allocation-free: results go into caller-owned objects.
 */
import { DEG, NM } from '../../core/units';

/** Mean Earth radius used by the nav model, m. */
export const NAV_EARTH_RADIUS_M = 6371008.8;
/** Earth radius in nautical miles. */
export const NAV_EARTH_RADIUS_NM = NAV_EARTH_RADIUS_M / NM;

/** Great-circle (haversine) distance between two lat/lon points in degrees, nautical miles. */
export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG, p2 = lat2 * DEG;
  const dp = p2 - p1, dl = (lon2 - lon1) * DEG;
  const s = Math.sin(dp / 2), t = Math.sin(dl / 2);
  const a = s * s + Math.cos(p1) * Math.cos(p2) * t * t;
  return 2 * NAV_EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Signed longitude difference lon − lon0 wrapped to [−180, 180). */
export function deltaLonDeg(lon: number, lon0: number): number {
  let d = (lon - lon0) % 360;
  if (d >= 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** A point on the map in nautical miles east (`x`) and north (`y`) of the projection centre. */
export interface MapPointNm { x: number; y: number }

/**
 * Local equirectangular projection centred on (lat0, lon0): x = Δλ·cos φ0·60, y = Δφ·60 (nm).
 * Accurate to well under a pixel at the ranges a cockpit map is used (< 100 nm); acceptable as a
 * schematic beyond that. The cosine is cached per centre latitude by the caller via `setCentre`.
 */
export class LocalProjection {
  lat0 = 0;
  lon0 = 0;
  private cosLat0 = 1;

  setCentre(lat0: number, lon0: number): void {
    this.lat0 = lat0; this.lon0 = lon0;
    this.cosLat0 = Math.max(0.01, Math.cos(lat0 * DEG));
  }

  /** Project (lat, lon) into `out` (nm east / north of the centre) and return it. */
  project(lat: number, lon: number, out: MapPointNm): MapPointNm {
    out.x = deltaLonDeg(lon, this.lon0) * 60 * this.cosLat0;
    out.y = (lat - this.lat0) * 60;
    return out;
  }
}
