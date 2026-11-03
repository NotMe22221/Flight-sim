/** Small spherical-earth helpers for map widgets (R = 6 371 008.8 m). Pure. */
import type { Geodetic } from '../core/types';

export const EARTH_RADIUS_M = 6_371_008.8;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface LatLon { lat: number; lon: number }

/** Great-circle distance in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const φ1 = a.lat * D2R, φ2 = b.lat * D2R;
  const dφ = (b.lat - a.lat) * D2R;
  const dλ = (b.lon - a.lon) * D2R;
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial true bearing a → b, deg in [0, 360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = a.lat * D2R, φ2 = b.lat * D2R;
  const dλ = (b.lon - a.lon) * D2R;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  const θ = Math.atan2(y, x) * R2D;
  return (θ + 360) % 360;
}

/** Point at `distM` along `bearing` from `a`. */
export function destination(a: LatLon, bearing: number, distM: number): LatLon {
  const δ = distM / EARTH_RADIUS_M;
  const θ = bearing * D2R;
  const φ1 = a.lat * D2R, λ1 = a.lon * D2R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: φ2 * R2D, lon: ((λ2 * R2D + 540) % 360) - 180 };
}

/** Local flat-earth offset (east, north) metres of `p` relative to `origin`; fine within ~100 nm. */
export function localOffsetM(origin: LatLon, p: LatLon): { east: number; north: number } {
  const dLon = ((p.lon - origin.lon + 540) % 360) - 180;
  const k = (Math.PI / 180) * EARTH_RADIUS_M;
  return { east: dLon * k * Math.cos(origin.lat * D2R), north: (p.lat - origin.lat) * k };
}

export function geodeticToLatLon(g: Geodetic): LatLon { return { lat: g.lat, lon: g.lon }; }

/**
 * Local magnetic variation (deg, east positive, in (−180, 180]) from the aircraft's true and
 * magnetic headings, which the flight model already reports: variation = true − magnetic.
 */
export function variationFromHeadings(headingTrueRad: number, headingMagRad: number): number {
  if (!Number.isFinite(headingTrueRad) || !Number.isFinite(headingMagRad)) return 0;
  const d = (headingTrueRad - headingMagRad) * R2D;
  const w = ((d + 180) % 360 + 360) % 360 - 180;
  return w === -180 ? 180 : w;
}

/** True bearing → magnetic, [0, 360): magnetic = true − variation (east positive). */
export function trueToMagnetic(trueDeg: number, variationDeg: number): number {
  const v = Number.isFinite(variationDeg) ? variationDeg : 0;
  const m = ((trueDeg - v) % 360 + 360) % 360;
  return Number.isFinite(m) ? m : 0;
}
