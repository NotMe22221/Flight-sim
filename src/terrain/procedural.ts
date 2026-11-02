/**
 * Procedural fallback terrain (docs/research/03 §5): deterministic heights and biome colours
 * as pure functions of (lon, lat) so that neighbouring tiles — at any zoom — agree exactly.
 *
 * Noise is evaluated in ground metres of a sinusoidal projection
 * `p = (R·λ·cos φ, R·φ)`, which depends on the point only (not on the tile), so continuity
 * across tile edges is exact to floating-point round-off.
 */
import { clamp, smoothstep } from '../core/math';
import { metersPerPixel, tileToLonLat } from '../geo/mercator';
import { EARTH_RADIUS } from '../geo/wgs84';
import { SimplexNoise2D } from './noise';

const D2R = Math.PI / 180;

export interface ProceduralPlateau {
  lat: number;
  lon: number;
  /** plateau elevation, m */
  elev: number;
  /** fully flat within this radius, m */
  radiusM: number;
  /** blend back to the noise terrain over this extra distance, m */
  featherM: number;
}

export interface ProceduralParams {
  seed: number;
  /** flat discs (e.g. the spawn airport at its published elevation) */
  plateaus?: readonly ProceduralPlateau[];
}

export const DEFAULT_PROCEDURAL_PARAMS: ProceduralParams = { seed: 1337, plateaus: [] };

/** Range of heights the model can produce (m); used by tests and AABB estimates. */
export const PROCEDURAL_MIN_H = -50;
export const PROCEDURAL_MAX_H = 3000;

/** sRGB biome palette (bytes). */
const COL_DEEP = [10, 38, 78], COL_SHALLOW = [34, 92, 122], COL_SAND = [194, 178, 128], COL_GRASS = [92, 128, 62],
  COL_FOREST = [44, 78, 38], COL_ROCK = [118, 110, 102], COL_SNOW = [238, 241, 245];

export class ProceduralTerrain {
  readonly params: ProceduralParams;
  private readonly nContinent: SimplexNoise2D;
  private readonly nMountain: SimplexNoise2D;
  private readonly nHills: SimplexNoise2D;
  private readonly nHumidity: SimplexNoise2D;

  constructor(params: ProceduralParams = DEFAULT_PROCEDURAL_PARAMS) {
    this.params = params;
    const s = params.seed >>> 0;
    this.nContinent = new SimplexNoise2D(s);
    this.nMountain = new SimplexNoise2D((s ^ 0x9e3779b9) >>> 0);
    this.nHills = new SimplexNoise2D((s + 0x7f4a7c15) >>> 0);
    this.nHumidity = new SimplexNoise2D((s ^ 0x85ebca6b) >>> 0);
  }

  /** Height (m) at a geodetic position. Deterministic; same (lon, lat) → same height. */
  height(lonDeg: number, latDeg: number): number {
    const lat = latDeg * D2R;
    const east = EARTH_RADIUS * lonDeg * D2R * Math.cos(lat);
    const north = EARTH_RADIUS * lat;
    const warp = 600 * this.nContinent.fbm(east / 9000 + 7.1, north / 9000 - 3.3, 3);
    const qx = (east + warp) / 25000, qy = (north - warp) / 25000;
    const continent = this.nContinent.fbm(qx, qy, 4);
    const mountains = this.nMountain.ridged(qx * 3.1, qy * 3.1, 5) * smoothstep(0.15, 0.6, continent);
    const hills = this.nHills.fbm(east / 2500, north / 2500, 5) * 80;
    let h = continent * 350 + mountains * 1200 + hills;
    if (h < 0) h = h * 0.08 - 10; // shallow seas, sea level at 0
    const plateaus = this.params.plateaus;
    if (plateaus && plateaus.length > 0) {
      for (const p of plateaus) {
        const dE = (lonDeg - p.lon) * D2R * EARTH_RADIUS * Math.cos(p.lat * D2R);
        const dN = (latDeg - p.lat) * D2R * EARTH_RADIUS;
        const d = Math.hypot(dE, dN);
        if (d >= p.radiusM + p.featherM) continue;
        const w = 1 - smoothstep(p.radiusM, p.radiusM + p.featherM, d);
        h += (p.elev - h) * w;
      }
    }
    return h;
  }

  /** 0..1 humidity field (low frequency) used for forest placement. */
  humidity(lonDeg: number, latDeg: number): number {
    const lat = latDeg * D2R;
    const east = EARTH_RADIUS * lonDeg * D2R * Math.cos(lat), north = EARTH_RADIUS * lat;
    return 0.5 + 0.5 * this.nHumidity.fbm(east / 40000 + 11.3, north / 40000 - 5.7, 3);
  }

  /**
   * Fill a `width`×`width` height grid for tile (z, x, y), sampled at pixel centres
   * (row 0 = north). Returns min/max.
   */
  heightsTile(z: number, x: number, y: number, width: number, out?: Float32Array): { heights: Float32Array; minH: number; maxH: number } {
    const n = width * width;
    const heights = out && out.length === n ? out : new Float32Array(n);
    let minH = Infinity, maxH = -Infinity;
    for (let j = 0; j < width; j++) {
      const lat = tileToLonLat(x, y + (j + 0.5) / width, z).lat;
      for (let i = 0; i < width; i++) {
        const lon = tileToLonLat(x + (i + 0.5) / width, y, z).lon;
        const h = this.height(lon, lat);
        heights[j * width + i] = h;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    return { heights, minH, maxH };
  }

  /**
   * Biome-coloured RGBA tile (`width`×`width`, row 0 = north) from a height grid of the same
   * size: water by depth, sand, grass, forest (humidity), rock by slope, snow by altitude.
   */
  imageryTile(heights: Float32Array, width: number, z: number, x: number, y: number, out?: Uint8ClampedArray): Uint8ClampedArray {
    const n = width * width;
    const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
    const latC = tileToLonLat(x + 0.5, y + 0.5, z).lat;
    const mpp = metersPerPixel(latC, z, width);
    const inv2 = 1 / (2 * mpp);
    const W = width;
    for (let j = 0; j < W; j++) {
      const lat = tileToLonLat(x, y + (j + 0.5) / W, z).lat;
      const jm = j > 0 ? j - 1 : 0, jp = j < W - 1 ? j + 1 : W - 1;
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const h = heights[k];
        const im = i > 0 ? i - 1 : 0, ip = i < W - 1 ? i + 1 : W - 1;
        const gx = (heights[j * W + ip] - heights[j * W + im]) * inv2;
        const gy = (heights[jp * W + i] - heights[jm * W + i]) * inv2;
        const slopeDeg = Math.atan(Math.hypot(gx, gy)) / D2R;
        const lon = tileToLonLat(x + (i + 0.5) / W, y, z).lon;
        const o = k * 4;
        if (h <= 0) {
          const t = Math.exp(h / 12); // 1 at the shore → 0 in deep water
          rgba[o] = COL_DEEP[0] + (COL_SHALLOW[0] - COL_DEEP[0]) * t;
          rgba[o + 1] = COL_DEEP[1] + (COL_SHALLOW[1] - COL_DEEP[1]) * t;
          rgba[o + 2] = COL_DEEP[2] + (COL_SHALLOW[2] - COL_DEEP[2]) * t;
          rgba[o + 3] = 255;
          continue;
        }
        const humidity = this.humidity(lon, lat);
        let wSnow = smoothstep(2300, 2600, h) * (1 - smoothstep(45, 60, slopeDeg));
        let wRock = smoothstep(30, 45, slopeDeg) * (1 - wSnow);
        let wSand = (1 - smoothstep(2, 6, h)) * (1 - wRock);
        let wForest = smoothstep(300, 500, h) * (1 - smoothstep(1600, 1800, h)) * smoothstep(0.3, 0.5, humidity) * (1 - wRock - wSnow);
        let wGrass = clamp(1 - wSnow - wRock - wSand - wForest, 0, 1);
        const sum = wSnow + wRock + wSand + wForest + wGrass || 1;
        wSnow /= sum; wRock /= sum; wSand /= sum; wForest /= sum; wGrass /= sum;
        // small deterministic texture variation (±6 %) from the hills noise
        const v = 1 + 0.06 * this.nHills.noise(i * 0.37 + x * 97.1, j * 0.37 + y * 53.7);
        for (let c = 0; c < 3; c++) {
          const col = COL_SNOW[c] * wSnow + COL_ROCK[c] * wRock + COL_SAND[c] * wSand + COL_FOREST[c] * wForest + COL_GRASS[c] * wGrass;
          rgba[o + c] = col * v;
        }
        rgba[o + 3] = 255;
      }
    }
    return rgba;
  }
}
