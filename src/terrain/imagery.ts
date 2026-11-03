/**
 * Imagery planning helpers shared by the main thread and the worker (pure, no DOM).
 *
 * A terrain tile at zoom zT takes its texture from the first provider in the chain that can
 * serve it; providers whose maxZoom < zT serve their parent tile `(zI, x >> k, y >> k)` with a
 * UV offset/scale (§2.2). Fetching/decoding lives in the worker (terrain.worker.ts); texture
 * creation on the main thread (TerrainSystem.ts).
 */
import type { ImageryProvider } from './providers';

export interface ImageryCandidate {
  providerId: string;
  /** URL to fetch, or null for the synthetic provider (generated from the tile's heights) */
  url: string | null;
  /** zoom of the imagery tile actually used (≤ zT) */
  zI: number;
  x: number;
  y: number;
}

/**
 * Ordered fallback chain for terrain tile (zT, x, y). Providers that cannot cover the zoom
 * (zT below their minZoom) are skipped; ones with a lower maxZoom serve their ancestor tile.
 */
export function planImagery(zT: number, x: number, y: number, providers: readonly ImageryProvider[]): ImageryCandidate[] {
  const out: ImageryCandidate[] = [];
  for (const p of providers) {
    const zI = Math.min(zT, p.maxZoom);
    if (zI < p.minZoom) continue;
    const k = zT - zI;
    const xi = x >> k, yi = y >> k;
    const procedural = p.format === 'none';
    out.push({ providerId: p.id, url: procedural ? null : p.url(zI, xi, yi), zI, x: xi, y: yi });
  }
  return out;
}

/**
 * UV transform for terrain tile (zT, x, y) textured with imagery tile zoom zI ≤ zT:
 * `uv' = uv * scale + offset`. Mesh v runs 1 at the north edge → 0 at the south edge (a
 * flipped image), so the row offset is counted from the bottom.
 */
export function imageryUvTransform(zT: number, x: number, y: number, zI: number, out: Float64Array | number[] = [0, 0, 0]): Float64Array | number[] {
  const k = zT - zI;
  if (k < 0) throw new Error(`imageryUvTransform: imagery zoom ${zI} finer than terrain zoom ${zT}`);
  const n = 2 ** k, m = n - 1;
  out[0] = (x & m) / n;
  out[1] = (m - (y & m)) / n;
  out[2] = 1 / n;
  return out;
}
