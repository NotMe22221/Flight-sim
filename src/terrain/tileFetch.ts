/**
 * Worker-side I/O: fetch through the Cache API ('terrain-v1'), decode elevation tiles and
 * create imagery bitmaps. Only terrain.worker.ts imports this file (it needs fetch, caches,
 * createImageBitmap and OffscreenCanvas); everything decode-related that can be pure lives
 * in terrarium.ts so Node tests cover it.
 */
import { decodeTerrarium, decodeTerrariumPng, type DecodedHeights } from './terrarium';

export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

/** Raw tile responses keyed by URL. Degrades to plain fetch when the Cache API is unavailable. */
export class TileCache {
  private opening: Promise<Cache | null> | null = null;
  private puts = 0;

  constructor(public readonly name: string, public readonly maxEntries: number) {}

  private open(): Promise<Cache | null> {
    if (!this.opening) {
      this.opening = typeof caches === 'undefined'
        ? Promise.resolve(null)
        : caches.open(this.name).catch(() => null);
    }
    return this.opening;
  }

  /** Cached response when present, otherwise a network fetch (stored when ok). Throws HttpError on non-2xx. */
  async fetch(url: string, signal: AbortSignal): Promise<Response> {
    const cache = await this.open();
    if (cache) {
      const hit = await cache.match(url).catch(() => undefined);
      if (hit) return hit;
    }
    const res = await fetch(url, { mode: 'cors', credentials: 'omit', signal });
    if (!res.ok) throw new HttpError(res.status, url);
    if (cache) {
      const copy = res.clone();
      cache.put(url, copy).then(() => this.afterPut(cache)).catch(() => undefined);
    }
    return res;
  }

  /** Every 200 insertions, drop the oldest 10 % when over the cap (keys() preserves insertion order in practice). */
  private async afterPut(cache: Cache): Promise<void> {
    if (++this.puts % 200 !== 0) return;
    const keys = await cache.keys();
    if (keys.length <= this.maxEntries) return;
    const drop = keys.slice(0, Math.ceil(keys.length * 0.1));
    await Promise.all(drop.map((k) => cache.delete(k)));
  }
}

/** Decode an elevation tile response: PNG bit-exactly via fast-png, WebP via the browser decoder. */
export async function decodeElevationResponse(res: Response, format: 'png' | 'webp', tileSize: number): Promise<DecodedHeights> {
  if (format === 'png') {
    const buf = await res.arrayBuffer();
    const d = decodeTerrariumPng(buf);
    if (d.width !== tileSize || d.height !== tileSize) throw new Error(`elevation tile is ${d.width}×${d.height}, expected ${tileSize}`);
    return d;
  }
  const blob = await res.blob();
  // Exact bytes: no premultiplication, no colour management (same options as Three's ImageBitmapLoader).
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return decodeTerrarium(img.data, img.width, img.height, 4);
  } finally {
    bmp.close();
  }
}

/** Imagery as a transferable ImageBitmap, flipped so that v = 0 is the south edge (texture.flipY must be false). */
export async function fetchImageryBitmap(cache: TileCache, url: string, signal: AbortSignal): Promise<ImageBitmap> {
  const res = await cache.fetch(url, signal);
  const blob = await res.blob();
  return createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}
