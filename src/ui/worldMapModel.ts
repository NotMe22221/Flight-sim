/**
 * Pure helpers behind the World Map canvas: which airport types to show at a zoom level, dot
 * sizes and label thresholds, the nearestAirports query for a view (and when to re-run it),
 * hit-testing, a unit-aware scale bar and runway geometry. Unit-tested in Node.
 */
import type { Airport } from '../core/types';
import type { RunwayEndChoice } from './UiHost';
import { destination, type LatLon } from './geoMath';
import { metersPerPixel, project, type MapView } from './mapProjection';

export type AirportType = Airport['type'];

/** Base dot radius in CSS px by airport type. */
export const AIRPORT_DOT_PX: Record<AirportType, number> = { large: 5, medium: 3.8, small: 2.6, seaplane: 2.4, heliport: 2.2 };

/** Px/deg below which only large airports are drawn (whole-world views). */
export const ZOOM_LARGE_ONLY = 6;
/** Px/deg below which small fields, heliports and seaplane bases are hidden (continental views). */
export const ZOOM_MEDIUM = 40;
/** Px/deg from which small-airport shards are requested from the nav database. */
export const ZOOM_LOAD_REGION = 60;
/** Px/deg from which the focused airport's runways are drawn to scale. */
export const ZOOM_RUNWAYS = 500;

export function airportTypeVisible(type: AirportType, pxPerDeg: number): boolean {
  if (type === 'large') return true;
  if (type === 'medium') return pxPerDeg >= ZOOM_LARGE_ONLY;
  return pxPerDeg >= ZOOM_MEDIUM;
}

/** Dot radius (CSS px): grows gently when zoomed in. */
export function airportDotRadius(type: AirportType, pxPerDeg: number): number {
  const k = Math.min(1.6, Math.max(0.8, 1 + 0.15 * Math.log2(Math.max(1e-6, pxPerDeg) / 200)));
  return AIRPORT_DOT_PX[type] * k;
}

const LABEL_ZOOM: Record<AirportType, number> = { large: 25, medium: 90, small: 260, seaplane: 400, heliport: 400 };
/** ICAO labels appear progressively so the map never turns into text soup. */
export function airportLabelVisible(type: AirportType, pxPerDeg: number): boolean { return pxPerDeg >= LABEL_ZOOM[type]; }

export interface AirportQuery { lat: number; lon: number; radiusNm: number; maxCount: number; pxPerDeg: number }

export const MAX_QUERY_NM = 3000;

/** The nearestAirports() call that covers the view (half-diagonal radius, generous count). */
export function airportQuery(view: MapView): AirportQuery {
  const halfDiagPx = Math.hypot(view.width, view.height) / 2;
  const radiusNm = Math.min(MAX_QUERY_NM, Math.max(5, (halfDiagPx / view.pxPerDeg) * 60));
  const maxCount = view.pxPerDeg < ZOOM_MEDIUM ? 2000 : 800;
  return { lat: view.centerLat, lon: view.centerLon, radiusNm, maxCount, pxPerDeg: view.pxPerDeg };
}

/** Re-query when the centre moved by > 25 % of the radius or the zoom changed by > 25 %. */
export function needsRefetch(prev: AirportQuery | null, next: AirportQuery): boolean {
  if (!prev) return true;
  const zoomRatio = next.pxPerDeg / prev.pxPerDeg;
  if (zoomRatio > 1.25 || zoomRatio < 0.8) return true;
  const dLat = (next.lat - prev.lat) * 60;
  const dLonDeg = ((next.lon - prev.lon + 540) % 360) - 180;
  const dLon = dLonDeg * 60 * Math.cos((next.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon) > 0.25 * prev.radiusNm;
}

/** Nearest visible airport to canvas point (x, y) within `maxPx`, or null. */
export function hitTestAirport<A extends Pick<Airport, 'position' | 'type'>>(airports: readonly A[], view: MapView, x: number, y: number, maxPx = 10): A | null {
  let best: A | null = null;
  let bestD = maxPx * maxPx;
  for (const a of airports) {
    if (!airportTypeVisible(a.type, view.pxPerDeg)) continue;
    const p = project(view, a.position.lon, a.position.lat);
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    // large airports win ties so a click on a cluster picks the airport you were aiming at
    if (d < bestD || (d === bestD && best !== null && a.type === 'large' && best.type !== 'large')) { best = a; bestD = d; }
  }
  return best;
}

const NICE = [1, 2, 5];
/** Largest 1-2-5 × 10ⁿ value ≤ v. */
export function niceFloor(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  let best = p;
  for (const n of NICE) if (n * p <= v) best = n * p;
  return best;
}

/** Scale bar in the user's distance unit: a nice length that fits in `maxPx`. */
export function scaleBar(view: MapView, lat: number, unit: 'nm' | 'km', maxPx = 120): { label: string; px: number } {
  const unitM = unit === 'nm' ? 1852 : 1000;
  const mpp = metersPerPixel(view, lat);
  const maxUnits = (mpp * maxPx) / unitM;
  const v = niceFloor(maxUnits);
  if (v <= 0) return { label: '', px: 0 };
  const label = v >= 1 ? `${v} ${unit}` : `${Math.round(v * unitM)} m`;
  return { label, px: (v * unitM) / mpp };
}

/** Threshold → far end of a chosen runway end (for drawing the departure runway). */
export function runwayLine(end: RunwayEndChoice): { from: LatLon; to: LatLon } {
  const from = { lat: end.threshold.lat, lon: end.threshold.lon };
  return { from, to: destination(from, end.headingDeg, end.lengthM) };
}

/** Zoom that frames an airport's runways (≈ 4 km across 300 px). */
export const AIRPORT_FOCUS_PX_PER_DEG = 3000;
