/** Web Mercator (EPSG:3857) slippy-map tile math. */
export const R_MERC = 6378137;
export const MERC_MAX = Math.PI * R_MERC; // 20037508.342789244
export const MAX_LAT = 85.05112878;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Fractional tile coordinates of (lon, lat) at zoom z. */
export function lonLatToTile(lonDeg: number, latDeg: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, latDeg)) * D2R;
  return {
    x: ((lonDeg + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n,
  };
}

/** Lon/lat of fractional tile coordinate (x, y) at zoom z. Pass integer x,y for the NW corner. */
export function tileToLonLat(x: number, y: number, z: number): { lon: number; lat: number } {
  const n = 2 ** z;
  return {
    lon: (x / n) * 360 - 180,
    lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * R2D,
  };
}

/** Ground metres per pixel at latitude for a 256-px tile scheme. */
export function metersPerPixel(latDeg: number, z: number, tileSize = 256): number {
  return (2 * Math.PI * R_MERC * Math.cos(latDeg * D2R)) / (tileSize * 2 ** z);
}

export function tileWidthMeters(latDeg: number, z: number, tileSize = 256): number {
  return metersPerPixel(latDeg, z, tileSize) * tileSize;
}

/** Wrap x into [0, 2^z) and clamp y into [0, 2^z - 1]. */
export function normalizeTile(x: number, y: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  let xi = Math.floor(x) % n;
  if (xi < 0) xi += n;
  const yi = Math.max(0, Math.min(n - 1, Math.floor(y)));
  return { x: xi, y: yi };
}

export const tileKey = (z: number, x: number, y: number): string => `${z}/${x}/${y}`;

/** Lon/lat bounds of tile (x, y, z): west, south, east, north in degrees. */
export function tileBounds(x: number, y: number, z: number): { west: number; south: number; east: number; north: number } {
  const nw = tileToLonLat(x, y, z);
  const se = tileToLonLat(x + 1, y + 1, z);
  return { west: nw.lon, north: nw.lat, east: se.lon, south: se.lat };
}
