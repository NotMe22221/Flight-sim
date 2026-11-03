/**
 * Pure Web-Mercator projection for the World Map canvas (the projection of MSFS's world map and of
 * web maps). It is conformal: runways cross at their real angles and airport diagrams keep their
 * shape at any latitude (a plate carrée stretches east-west by 1/cos(lat): +25 % at KSFO, ×2 at 60°).
 * A view is a centre lon/lat plus a scale in pixels per degree of longitude; vertically the map uses
 * the Mercator ordinate in "equatorial degrees" (≈ latitude near the equator). Pan/zoom helpers keep
 * the latitude range clamped to ±MAX_LAT so the map never scrolls off the poles.
 */

export interface MapView {
  centerLon: number;
  centerLat: number;
  /** uniform scale, px per degree (same for lon and lat) */
  pxPerDeg: number;
  width: number;
  height: number;
}

export interface LonLat { lon: number; lat: number }
export interface Px { x: number; y: number }
export interface Bounds { minLon: number; maxLon: number; minLat: number; maxLat: number }

export const MAX_LAT = 85;
export const MIN_PX_PER_DEG = 1;
export const MAX_PX_PER_DEG = 50_000;
/** Metres per degree of latitude (WGS84 mean). */
export const M_PER_DEG_LAT = 111_320;

export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

/** Wraps longitude into [-180, 180). */
export function wrapLon(lon: number): number {
  if (!Number.isFinite(lon)) return 0;
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  if (l === 180) l = -180;
  return l;
}

/** Latitude clamped to the projectable range. */
export function clampLat(lat: number): number { return clamp(lat, -MAX_LAT, MAX_LAT); }

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
/** Mercator ordinate of a latitude (clamped to ±MAX_LAT), in equatorial degrees. */
export function mercatorY(lat: number): number { return Math.log(Math.tan(Math.PI / 4 + (clampLat(lat) * D2R) / 2)) * R2D; }
/** Latitude of a Mercator ordinate (equatorial degrees). */
export function mercatorLat(y: number): number { return (2 * Math.atan(Math.exp(y * D2R)) - Math.PI / 2) * R2D; }
/** Ordinate of the ±MAX_LAT edge. */
const MAX_Y = mercatorY(MAX_LAT);

/** Shortest signed longitude difference a − b in (−180, 180]. */
export function lonDelta(a: number, b: number): number {
  const d = wrapLon(a - b);
  return d;
}

export function zoomLevelToPxPerDeg(z: number): number { return clamp(2 ** z, MIN_PX_PER_DEG, MAX_PX_PER_DEG); }
export function pxPerDegToZoomLevel(pxPerDeg: number): number { return Math.log2(clamp(pxPerDeg, MIN_PX_PER_DEG, MAX_PX_PER_DEG)); }

export function createView(centerLon: number, centerLat: number, pxPerDeg: number, width: number, height: number): MapView {
  return clampView({ centerLon, centerLat, pxPerDeg, width, height });
}

/** lon/lat → canvas pixel (origin top-left, y down). */
export function project(view: MapView, lon: number, lat: number): Px {
  return {
    x: view.width / 2 + lonDelta(lon, view.centerLon) * view.pxPerDeg,
    y: view.height / 2 - (mercatorY(lat) - mercatorY(view.centerLat)) * view.pxPerDeg,
  };
}

/** canvas pixel → lon/lat (lon wrapped). */
export function unproject(view: MapView, x: number, y: number): LonLat {
  return {
    lon: wrapLon(view.centerLon + (x - view.width / 2) / view.pxPerDeg),
    lat: mercatorLat(mercatorY(view.centerLat) - (y - view.height / 2) / view.pxPerDeg),
  };
}

/** Keeps the scale and latitude range legal; the centre is moved rather than the edges cut. */
export function clampView(view: MapView): MapView {
  const pxPerDeg = clamp(view.pxPerDeg, MIN_PX_PER_DEG, MAX_PX_PER_DEG);
  const halfHeight = view.height / 2 / pxPerDeg;
  const maxCenterY = Math.max(0, MAX_Y - halfHeight);
  const cy = clamp(mercatorY(view.centerLat), -maxCenterY, maxCenterY);
  return {
    centerLon: wrapLon(view.centerLon),
    centerLat: mercatorLat(cy),
    pxPerDeg,
    width: view.width,
    height: view.height,
  };
}

/** Pans by a pixel delta (drag: moving the pointer right moves the centre west, down moves it north). */
export function pan(view: MapView, dxPx: number, dyPx: number): MapView {
  return clampView({
    ...view,
    centerLon: view.centerLon - dxPx / view.pxPerDeg,
    centerLat: mercatorLat(mercatorY(view.centerLat) + dyPx / view.pxPerDeg),
  });
}

/** Zooms by `factor` about the canvas point (x, y); the lon/lat under the cursor stays put (unless clamping intervenes). */
export function zoomAt(view: MapView, x: number, y: number, factor: number): MapView {
  const anchorLon = view.centerLon + (x - view.width / 2) / view.pxPerDeg;
  const anchorY = mercatorY(view.centerLat) - (y - view.height / 2) / view.pxPerDeg;
  const pxPerDeg = clamp(view.pxPerDeg * factor, MIN_PX_PER_DEG, MAX_PX_PER_DEG);
  return clampView({
    ...view,
    pxPerDeg,
    centerLon: anchorLon - (x - view.width / 2) / pxPerDeg,
    centerLat: mercatorLat(anchorY + (y - view.height / 2) / pxPerDeg),
  });
}

export function resize(view: MapView, width: number, height: number): MapView {
  return clampView({ ...view, width, height });
}

export function visibleBounds(view: MapView): Bounds {
  const halfW = view.width / 2 / view.pxPerDeg;
  const halfH = view.height / 2 / view.pxPerDeg;
  const cy = mercatorY(view.centerLat);
  return {
    minLon: view.centerLon - halfW,
    maxLon: view.centerLon + halfW,
    minLat: mercatorLat(cy - halfH),
    maxLat: mercatorLat(cy + halfH),
  };
}

/** View that shows the whole bounds with `padding` px around. */
export function fitBounds(b: Bounds, width: number, height: number, padding = 24): MapView {
  const lonSpan = Math.max(1e-6, Math.abs(lonDelta(b.maxLon, b.minLon)) || Math.abs(b.maxLon - b.minLon));
  const y0 = mercatorY(b.minLat), y1 = mercatorY(b.maxLat);
  const ySpan = Math.max(1e-6, y1 - y0);
  const pxPerDeg = Math.min((width - 2 * padding) / lonSpan, (height - 2 * padding) / ySpan);
  return clampView({
    centerLon: b.minLon + lonDelta(b.maxLon, b.minLon) / 2,
    centerLat: mercatorLat((y0 + y1) / 2),
    pxPerDeg, width, height,
  });
}

/** Ground metres per pixel at a latitude (for scale bars); Mercator is isotropic, so east and north alike. */
export function metersPerPixel(view: MapView, lat: number): number {
  return (M_PER_DEG_LAT * Math.max(0.05, Math.cos(lat * Math.PI / 180))) / view.pxPerDeg;
}

const GRATICULE_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 45, 90];
/** Degree step so graticule lines are at least `minPx` apart. */
export function graticuleStep(pxPerDeg: number, minPx = 80): number {
  for (const s of GRATICULE_STEPS) if (s * pxPerDeg >= minPx) return s;
  return 90;
}

/** A nice scale-bar length (metres) that is at most `maxPx` wide. */
export function scaleBarMeters(view: MapView, lat: number, maxPx = 120): { meters: number; px: number } {
  const mpp = metersPerPixel(view, lat);
  const target = mpp * maxPx;
  const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000];
  let meters = nice[0];
  for (const n of nice) if (n <= target) meters = n;
  return { meters, px: meters / mpp };
}
