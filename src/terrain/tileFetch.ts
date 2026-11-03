/**
 * Tile I/O shared by the worker and the in-thread loader: fetch through the Cache API
 * ('terrain-v1') with a timeout, decode elevation tiles and create imagery bitmaps. PNG
 * elevation decodes with fast-png (bit exact, works in Node); WebP elevation and imagery need
 * `createImageBitmap` (browser only). Pure decoding lives in terrarium.ts.
 */
import { decodeTerrarium, decodeTerrariumPng, type DecodedHeights } from './terrarium';

export class HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

/** The request took longer than the cache's timeout (headers + body). */
export class TileTimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`timed out after ${ms} ms: ${url}`);
    this.name = 'TimeoutError';
  }
}

/**
 * True when a failure says nothing about the tile's existence (network down, timeout, 5xx,
 * rate limiting) — worth retrying later — as opposed to a definitive 4xx "no such tile".
 */
export function isTransientFetchError(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429 || err.status === 408;
  return err instanceof TileTimeoutError || err instanceof TypeError;
}

/** `fetch`-compatible function (injected in tests and by the in-thread loader). */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** The platform fetch, called unbound-safe (some browsers throw "Illegal invocation" otherwise). */
export const platformFetch: FetchFn = (url, init) => fetch(url, init);

/** Default per-request timeout (headers + body), ms. */
export const TILE_FETCH_TIMEOUT_MS = 15_000;

/** Raw tile bytes keyed by URL. Degrades to plain fetch when the Cache API is unavailable. */
export class TileCache {
  private opening: Promise<Cache | null> | null = null;
  private puts = 0;

  /**
   * @param fetchFn network fetch (defaults to the platform fetch)
   * @param useCacheApi set false to bypass the Cache API (tests, injected fetch)
   * @param timeoutMs abort a request whose response body has not fully arrived after this long
   */
  constructor(
    public readonly name: string,
    public readonly maxEntries: number,
    private readonly fetchFn: FetchFn = platformFetch,
    private readonly useCacheApi = true,
    public readonly timeoutMs = TILE_FETCH_TIMEOUT_MS,
  ) {}

  private open(): Promise<Cache | null> {
    if (!this.opening) {
      this.opening = !this.useCacheApi || typeof caches === 'undefined'
        ? Promise.resolve(null)
        : caches.open(this.name).catch(() => null);
    }
    return this.opening;
  }

  /**
   * Tile bytes from the cache or the network (stored when ok). Throws HttpError on non-2xx,
   * TileTimeoutError after `timeoutMs`, and the caller's abort reason when `signal` aborts.
   */
  async fetchBlob(url: string, signal: AbortSignal): Promise<Blob> {
    const cache = await this.open();
    if (cache) {
      const hit = await cache.match(url).catch(() => undefined);
      if (hit) return hit.blob();
    }
    const ctrl = new AbortController();
    let timedOut = false;
    const onAbort = (): void => ctrl.abort(signal.reason);
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(new TileTimeoutError(url, this.timeoutMs)); }, this.timeoutMs);
    try {
      const res = await this.fetchFn(url, { mode: 'cors', credentials: 'omit', signal: ctrl.signal });
      if (!res.ok) throw new HttpError(res.status, url);
      if (cache) cache.put(url, res.clone()).then(() => this.afterPut(cache)).catch(() => undefined);
      return await res.blob();
    } catch (err) {
      if (timedOut && !signal.aborted) throw new TileTimeoutError(url, this.timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Drop the stored response for `url` (one that failed to decode — a corrupt entry or a 200
   * error page) so the next request refetches it instead of failing forever. Never throws.
   */
  async evict(url: string): Promise<void> {
    const cache = await this.open();
    if (cache) await cache.delete(url).catch(() => false);
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

/** Decode elevation tile bytes: PNG bit-exactly via fast-png, WebP via the browser decoder. */
export async function decodeElevationBlob(blob: Blob, format: 'png' | 'webp', tileSize: number): Promise<DecodedHeights> {
  if (format === 'png') {
    const d = decodeTerrariumPng(await blob.arrayBuffer());
    if (d.width !== tileSize || d.height !== tileSize) throw new Error(`elevation tile is ${d.width}×${d.height}, expected ${tileSize}`);
    return d;
  }
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
  const blob = await cache.fetchBlob(url, signal);
  try {
    return await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch (err) {
    void cache.evict(url); // undecodable bytes must not stay cached
    throw err;
  }
}
