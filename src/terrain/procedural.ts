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

/**
 * sRGB land-cover palette (bytes), in the tones of true-colour satellite imagery (Sentinel-2-like:
 * vegetation darker and less saturated than paint greens). Grass, scrub and field tones are albedos for
 * the sky's calibrated light (src/sky/README.md "Calibration"): a lowland around an airport reads as a mid
 * green at a clear noon (G ≈ 80–130 / 255, R and B lower) — the earlier, ≈ 2.2 × brighter tones were tuned
 * against a ≈ 4 × too dim sun and rendered as straw (≈ 182/169/119).
 */
export const COL_LUSH = [44, 66, 30], COL_GRASS = [62, 80, 40], COL_DRY = [100, 92, 60], COL_SCRUB = [70, 68, 46];
const COL_DEEP = [12, 30, 46], COL_SHALLOW = [38, 74, 78], COL_WET_SAND = [138, 128, 100], COL_SAND = [204, 190, 150],
  COL_FOREST = [42, 62, 36], COL_CONIFER = [34, 50, 33],
  COL_ALPINE = [120, 117, 92], COL_ROCK = [124, 117, 108], COL_DARK_ROCK = [90, 86, 82], COL_SNOW = [236, 240, 246];
/** Field patchwork tones (crops, pasture, fallow, stubble), same calibration as the grass. */
export const FIELD_TONES = [[54, 74, 32], [72, 84, 42], [92, 86, 54], [44, 62, 28], [80, 70, 50], [62, 78, 36], [102, 94, 60], [58, 66, 42]];

/** Integer hash of a lattice cell → 0…1 (deterministic, platform independent). */
function cellHash(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class ProceduralTerrain {
  readonly params: ProceduralParams;
  private readonly nContinent: SimplexNoise2D;
  private readonly nMountain: SimplexNoise2D;
  private readonly nHills: SimplexNoise2D;
  private readonly nHumidity: SimplexNoise2D;
  /** land-cover patches (dry/lush, forest edges, snow line, field warp) */
  private readonly nCover: SimplexNoise2D;

  constructor(params: ProceduralParams = DEFAULT_PROCEDURAL_PARAMS) {
    this.params = params;
    const s = params.seed >>> 0;
    this.nContinent = new SimplexNoise2D(s);
    this.nMountain = new SimplexNoise2D((s ^ 0x9e3779b9) >>> 0);
    this.nHills = new SimplexNoise2D((s + 0x7f4a7c15) >>> 0);
    this.nHumidity = new SimplexNoise2D((s ^ 0x85ebca6b) >>> 0);
    this.nCover = new SimplexNoise2D((s + 0x632be5ab) >>> 0);
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
   * Land-cover RGBA tile (`width`×`width`, row 0 = north) from a height grid of the same size: water by
   * depth, wet sand and beaches at the shore, lowland fields (a warped patchwork of crop/pasture/fallow
   * tones), grass that drifts between lush and dry, forest by humidity (conifers higher up), scrub on dry
   * slopes, alpine meadow, rock by slope and altitude, snow above a noisy snow line. Every input is a
   * function of the ground position (sinusoidal metres) and the heights, so neighbouring tiles and zooms
   * agree; detail finer than the tile's pixels fades to its average instead of aliasing.
   */
  imageryTile(heights: Float32Array, width: number, z: number, x: number, y: number, out?: Uint8ClampedArray): Uint8ClampedArray {
    const n = width * width;
    const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
    const latC = tileToLonLat(x + 0.5, y + 0.5, z).lat;
    const mpp = metersPerPixel(latC, z, width);
    const inv2 = 1 / (2 * mpp);
    const W = width;
    const nc = this.nCover;
    // fade of detail by pixel size: fields (≈ 250 m) and 40 m mottling
    const wFields = 1 - smoothstep(40, 140, mpp);
    const wMottle = 1 - smoothstep(8, 30, mpp);
    const col = [0, 0, 0];
    for (let j = 0; j < W; j++) {
      const lat = tileToLonLat(x, y + (j + 0.5) / W, z).lat;
      const latR = lat * D2R, cosLat = Math.cos(latR), north = EARTH_RADIUS * latR;
      const jm = j > 0 ? j - 1 : 0, jp = j < W - 1 ? j + 1 : W - 1;
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const h = heights[k];
        const im = i > 0 ? i - 1 : 0, ip = i < W - 1 ? i + 1 : W - 1;
        const gx = (heights[j * W + ip] - heights[j * W + im]) * inv2;
        const gy = (heights[jp * W + i] - heights[jm * W + i]) * inv2;
        const slopeDeg = Math.atan(Math.hypot(gx, gy)) / D2R;
        const lon = tileToLonLat(x + (i + 0.5) / W, y, z).lon;
        const east = EARTH_RADIUS * lon * D2R * cosLat;
        const o = k * 4;
        if (h <= 0) {
          const t = Math.exp(h / 10); // 1 at the shore → 0 in deep water
          for (let c = 0; c < 3; c++) rgba[o + c] = COL_DEEP[c] + (COL_SHALLOW[c] - COL_DEEP[c]) * t;
          rgba[o + 3] = 255;
          continue;
        }
        const humidity = this.humidity(lon, lat);
        const patch = nc.fbm(east / 1800 + 3.1, north / 1800 - 7.7, 3); // −1…1, km-scale patches
        const dry = clamp(0.3 + 0.6 * nc.fbm(east / 7000 - 13.3, north / 7000 + 2.9, 2) - 0.6 * (humidity - 0.5), 0, 1);
        const snowLine = 2550 + 220 * nc.noise(east / 4000 + 1.7, north / 4000 - 4.2);
        // weights (normalised below)
        const wSnow = smoothstep(snowLine - 120, snowLine + 120, h) * (1 - smoothstep(40, 55, slopeDeg));
        const wRock = clamp(smoothstep(28, 42, slopeDeg) + 0.7 * smoothstep(2100, 2600, h), 0, 1) * (1 - wSnow);
        // beaches: the narrow band just above the waterline (a DEM pixel or two), not every low flat
        const shore = (1 - smoothstep(0.6, 1.8, h)) * (1 - smoothstep(6, 12, slopeDeg));
        const wSand = shore * (1 - wRock);
        const forestBand = (1 - smoothstep(1800, 2200, h)) * smoothstep(0.42, 0.6, humidity + 0.22 * patch + 0.1 * smoothstep(6, 20, slopeDeg));
        const wForest = forestBand * (1 - wRock - wSnow) * (1 - wSand);
        const alpine = smoothstep(1700, 2100, h) * (1 - wRock - wSnow - wForest);
        const lowFlat = (1 - smoothstep(450, 800, h)) * (1 - smoothstep(4, 9, slopeDeg));
        const wField = Math.max(lowFlat * (1 - wForest - wSand - wRock) * (0.45 + 0.45 * (patch + 1) * 0.5), 0) * wFields;
        const wScrub = Math.max(smoothstep(8, 22, slopeDeg) * dry * (1 - wForest - wRock - wSnow - wSand) * (1 - smoothstep(1800, 2200, h)), 0);
        const wGrass = clamp(1 - wSnow - wRock - wSand - wForest - alpine - wField - wScrub, 0, 1);
        const sum = wSnow + wRock + wSand + wForest + alpine + wField + wScrub + wGrass || 1;
        // field tone from a warped lattice (≈ 260 × 190 m parcels)
        const wx = east + 90 * nc.noise(east / 700, north / 700), wy = north + 90 * nc.noise(east / 700 + 9.3, north / 700 - 4.1);
        const fieldTone = FIELD_TONES[Math.floor(cellHash(Math.floor(wx / 260), Math.floor(wy / 190), this.params.seed) * FIELD_TONES.length) % FIELD_TONES.length];
        const conifer = smoothstep(700, 1300, h);
        const wet = 1 - smoothstep(0.2, 1.0, h);
        const rockTone = 0.5 + 0.5 * nc.noise(east / 300 - 2.2, north / 300 + 6.1);
        for (let c = 0; c < 3; c++) {
          const grass = COL_LUSH[c] + (COL_DRY[c] - COL_LUSH[c]) * dry + (COL_GRASS[c] - COL_LUSH[c]) * (1 - Math.abs(dry - 0.5) * 2) * 0.5;
          const forest = COL_FOREST[c] + (COL_CONIFER[c] - COL_FOREST[c]) * conifer;
          const sand = COL_SAND[c] + (COL_WET_SAND[c] - COL_SAND[c]) * wet;
          const rock = COL_DARK_ROCK[c] + (COL_ROCK[c] - COL_DARK_ROCK[c]) * rockTone;
          col[c] = (COL_SNOW[c] * wSnow + rock * wRock + sand * wSand + forest * wForest + COL_ALPINE[c] * alpine + fieldTone[c] * wField + COL_SCRUB[c] * wScrub + grass * wGrass) / sum;
        }
        // mottling (±7 %) at ≈ 40 m, a function of the ground position only
        const v = 1 + 0.07 * wMottle * nc.noise(east / 40 + 0.5, north / 40 - 0.5) + 0.04 * patch;
        for (let c = 0; c < 3; c++) rgba[o + c] = col[c] * v;
        rgba[o + 3] = 255;
      }
    }
    return rgba;
  }
}
