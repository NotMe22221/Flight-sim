/**
 * Tile maths for the scenery: which z14 tiles surround a point (nearest first), and the
 * tile-local ENU frame every tile's geometry is built in.
 *
 * Tile-local frame: a tangent plane at the tile centre (ellipsoid height 0), axes as the render
 * frame (x = East, y = Up, z = South). MVT coordinates (x right, y down, 0…extent) map to it
 * exactly through geodetic → ECEF → ENU, so neighbouring tiles line up to the millimetre once
 * each tile group is placed in the current LocalFrame (see `placement.ts`).
 */
import { lonLatToTile, tileToLonLat } from '../geo/mercator';
import { LocalFrame, WGS84_A, WGS84_E2 } from '../geo/wgs84';

export const SCENERY_ZOOM = 14;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface TileId { z: number; x: number; y: number }
export interface TileDist extends TileId { key: string; distM: number; centerDistM: number }

export const sceneryTileKey = (z: number, x: number, y: number): string => `${z}/${x}/${y}`;

export function parseTileKey(key: string): TileId | null {
  const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(key);
  return m ? { z: +m[1], x: +m[2], y: +m[3] } : null;
}

/** Lon/lat (deg) of the tile centre. */
export function tileCenter(z: number, x: number, y: number): { lat: number; lon: number } {
  const c = tileToLonLat(x + 0.5, y + 0.5, z);
  return { lat: c.lat, lon: c.lon };
}

/** Expand a URL template ({z}/{x}/{y}, also {-y} for TMS). */
export function expandTileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{-y\}/g, String(2 ** z - 1 - y))
    .replace(/\{y\}/g, String(y));
}

/**
 * Tiles within `radiusM` of (lat, lon) at zoom z, sorted by distance from the point to the
 * tile rectangle (0 inside), ties by centre distance. Equirectangular around the point:
 * < 0.1 % error within 10 km, plenty for streaming decisions.
 */
export function tilesAround(lat: number, lon: number, radiusM: number, z = SCENERY_ZOOM, out: TileDist[] = []): TileDist[] {
  out.length = 0;
  const n = 2 ** z;
  const ky = (Math.PI * 6371000) / 180;
  const kx = ky * Math.cos(lat * D2R);
  const dLat = radiusM / ky, dLon = radiusM / Math.max(kx, 1e-6);
  const a = lonLatToTile(lon - dLon, Math.min(85, lat + dLat), z);
  const b = lonLatToTile(lon + dLon, Math.max(-85, lat - dLat), z);
  const x0 = Math.floor(a.x), x1 = Math.floor(b.x), y0 = Math.max(0, Math.floor(a.y)), y1 = Math.min(n - 1, Math.floor(b.y));
  for (let ty = y0; ty <= y1; ty++) {
    const north = tileToLonLat(0, ty, z).lat, south = tileToLonLat(0, ty + 1, z).lat;
    for (let tx = x0; tx <= x1; tx++) {
      const west = (tx / n) * 360 - 180, east = ((tx + 1) / n) * 360 - 180;
      const cx = lon < west ? west : lon > east ? east : lon;
      const cy = lat < south ? south : lat > north ? north : lat;
      const distM = Math.hypot((cx - lon) * kx, (cy - lat) * ky);
      if (distM > radiusM) continue;
      const centerDistM = Math.hypot(((west + east) / 2 - lon) * kx, ((north + south) / 2 - lat) * ky);
      const wx = ((tx % n) + n) % n;
      out.push({ z, x: wx, y: ty, key: sceneryTileKey(z, wx, ty), distM, centerDistM });
    }
  }
  out.sort((p, q) => p.distM - q.distM || p.centerDistM - q.centerDistM);
  return out;
}

/**
 * Projects tile coordinates of one tile into its tile-local ENU frame (metres) and back.
 * `toLocal` writes [x = east, z = south]; the vertical (curvature drop ≤ 0.1 m inside a tile)
 * is left to the ground sampling, which places every vertex on the terrain anyway.
 */
export class TileProjector {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly extent: number;
  readonly frame: LocalFrame;
  readonly centerLat: number;
  readonly centerLon: number;
  /** approximate metres per tile unit at the centre (for tolerances and spacings) */
  readonly unitM: number;
  private readonly n: number;

  constructor(z: number, x: number, y: number, extent = 4096) {
    this.z = z; this.x = x; this.y = y; this.extent = extent;
    this.n = 2 ** z;
    const c = tileCenter(z, x, y);
    this.centerLat = c.lat;
    this.centerLon = c.lon;
    this.frame = new LocalFrame(c.lat, c.lon, 0);
    this.unitM = (2 * Math.PI * WGS84_A * Math.cos(c.lat * D2R)) / (this.n * extent);
  }

  /** Lon/lat (deg) of tile coordinates. */
  lonLat(px: number, py: number, out: { lon: number; lat: number }): { lon: number; lat: number } {
    const fx = this.x + px / this.extent, fy = this.y + py / this.extent;
    out.lon = (fx / this.n) * 360 - 180;
    out.lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / this.n))) * R2D;
    return out;
  }

  /** Tile coordinates → local (east, south) metres, written to out[o], out[o + 1]. */
  toLocal(px: number, py: number, out: { [i: number]: number }, o = 0): void {
    const fx = this.x + px / this.extent, fy = this.y + py / this.extent;
    const lon = ((fx / this.n) * 2 - 1) * Math.PI;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / this.n)));
    const sl = Math.sin(lat), cl = Math.cos(lat);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl);
    const px3 = N * cl * Math.cos(lon), py3 = N * cl * Math.sin(lon), pz3 = N * (1 - WGS84_E2) * sl;
    const f = this.frame, O = f.origin;
    const dx = px3 - O[0], dy = py3 - O[1], dz = pz3 - O[2];
    out[o] = f.east[0] * dx + f.east[1] * dy + f.east[2] * dz;
    out[o + 1] = -(f.north[0] * dx + f.north[1] * dy + f.north[2] * dz);
  }

  /** Local (east, south) metres → lon/lat (deg) on the ellipsoid. */
  toLonLat(east: number, south: number, out: { lat: number; lon: number; alt: number } = { lat: 0, lon: 0, alt: 0 }): { lat: number; lon: number; alt: number } {
    // the point on the tangent plane is a little above the ellipsoid; drop it along the local up
    const d2 = east * east + south * south;
    return this.frame.nedToGeodetic(-south, east, d2 / (2 * 6371000), out);
  }

  /** Local (east, south) metres → fractional tile coordinates (inverse of toLocal, via lon/lat). */
  toTile(east: number, south: number): { px: number; py: number } {
    const g = this.toLonLat(east, south);
    const t = lonLatToTile(g.lon, g.lat, this.z);
    return { px: (t.x - this.x) * this.extent, py: (t.y - this.y) * this.extent };
  }
}

/** Integer hash (deterministic across runs and threads). */
export function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash → [0, 1). */
export const hash01 = (a: number, b: number): number => hash2(a, b) / 4294967296;

/** Seed for a tile, so every tile scatters its own deterministic pattern. */
export const tileSeed = (z: number, x: number, y: number): number => hash2(hash2(z, x), y);
