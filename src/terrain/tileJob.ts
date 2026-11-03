/**
 * One tile load, shared verbatim by the module worker (terrain.worker.ts) and the in-thread
 * fallback (inThreadWorker.ts) so Node tests exercise the production path:
 *
 *   elevation: provider tile → ancestor tiles' sub-square (parent fallback) → procedural
 *   → runway flattening → curved mesh + ocean patch (tilePipeline.ts)
 *   imagery:   EOX → GIBS (z ≤ 8) → procedural colours (from the tile's own heights)
 *
 * Never throws: every failure becomes an `error` or `aborted` response.
 */
import { ProceduralTerrain, type ProceduralParams } from './procedural';
import type { ImageryPayload, LoadRequest, TileResponse, WorkerResponse } from './protocol';
import { extractSubGrid } from './sampling';
import { HttpError, decodeElevationResponse, fetchImageryBitmap, type TileCache } from './tileFetch';
import { runTilePipeline } from './tilePipeline';

/** Environment of a job: the network cache and what the platform can decode. */
export interface TileJobContext {
  cache: TileCache;
  /** `createImageBitmap` exists (browser main thread or worker); false in Node → bitmap imagery is skipped */
  canDecodeBitmaps: boolean;
  /** procedural generator for a parameter set (cached by the caller) */
  procedural(params: ProceduralParams): ProceduralTerrain;
}

export interface TileJobResult {
  response: WorkerResponse;
  /** buffers / bitmaps to transfer when posting from a worker */
  transfer: Transferable[];
}

interface Dem { heights: Float32Array; width: number; providerId: string; zoom: number }

/** A memoising procedural-generator factory (one generator per distinct parameter set). */
export function createProceduralCache(): (params: ProceduralParams) => ProceduralTerrain {
  let last: { key: string; gen: ProceduralTerrain } | null = null;
  return (params) => {
    const key = JSON.stringify(params);
    if (!last || last.key !== key) last = { key, gen: new ProceduralTerrain(params) };
    return last.gen;
  };
}

/** True for fetch/abort-signal cancellations (DOMException or any error named AbortError). */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  }
}

async function loadElevation(req: LoadRequest, signal: AbortSignal, ctx: TileJobContext): Promise<Dem> {
  let lastError: unknown = new Error('no elevation source');
  for (const src of req.elevation) {
    throwIfAborted(signal);
    try {
      if (src.url === null || src.format === 'none') {
        const t = ctx.procedural(req.procedural).heightsTile(req.z, req.x, req.y, src.tileSize);
        return { heights: t.heights, width: src.tileSize, providerId: src.providerId, zoom: req.z };
      }
      const res = await ctx.cache.fetch(src.url, signal);
      const d = await decodeElevationResponse(res, src.format, src.tileSize);
      if (!src.sub) return { heights: d.heights, width: d.width, providerId: src.providerId, zoom: src.zoom };
      const heights = extractSubGrid(d.heights, d.width, src.sub.depth, src.sub.x, src.sub.y, d.width);
      return { heights, width: d.width, providerId: src.providerId, zoom: src.zoom };
    } catch (err) {
      if (isAbortError(err, signal)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

async function loadImagery(req: LoadRequest, dem: Dem, signal: AbortSignal, ctx: TileJobContext): Promise<ImageryPayload> {
  for (const c of req.imagery) {
    throwIfAborted(signal);
    try {
      if (c.url === null) {
        const data = ctx.procedural(req.procedural).imageryTile(dem.heights, dem.width, req.z, req.x, req.y);
        return { kind: 'rgba', providerId: c.providerId, zI: req.z, data, width: dem.width };
      }
      if (!ctx.canDecodeBitmaps) continue;
      const bitmap = await fetchImageryBitmap(ctx.cache, c.url, signal);
      return { kind: 'bitmap', providerId: c.providerId, zI: c.zI, x: c.x, y: c.y, bitmap };
    } catch (err) {
      if (isAbortError(err, signal)) throw err;
      // next candidate
    }
  }
  return null;
}

/** Run one load request to completion. Resolves with the response to post; never rejects. */
export async function runTileJob(req: LoadRequest, signal: AbortSignal, ctx: TileJobContext): Promise<TileJobResult> {
  const t0 = performance.now();
  let imagery: ImageryPayload = null;
  try {
    const dem = await loadElevation(req, signal, ctx);
    const out = runTilePipeline({
      z: req.z, x: req.x, y: req.y, heights: dem.heights, width: dem.width, frame: req.frame,
      quads: req.quads, skirt: req.skirt, runways: req.runways, fullHeights: req.fullHeights, water: req.water,
    });
    imagery = await loadImagery(req, dem, signal, ctx);
    throwIfAborted(signal);
    const m = out.mesh;
    const transfer: Transferable[] = [m.position.buffer, m.normal.buffer, m.uv.buffer, m.height.buffer];
    if (out.water) transfer.push(out.water.position.buffer, out.water.normal.buffer, out.water.uv.buffer, out.water.depth.buffer);
    if (!transfer.includes(out.heights.buffer)) transfer.push(out.heights.buffer);
    if (imagery?.kind === 'bitmap') transfer.push(imagery.bitmap);
    else if (imagery?.kind === 'rgba' && !transfer.includes(imagery.data.buffer)) transfer.push(imagery.data.buffer);
    const response: TileResponse = {
      type: 'tile', key: req.key, z: req.z, x: req.x, y: req.y, frame: req.frame,
      elevationProviderId: dem.providerId, elevationZoom: dem.zoom,
      mesh: {
        position: m.position, normal: m.normal, uv: m.uv, height: m.height, vertexCount: m.vertexCount, quads: m.quads,
        centerEcef: m.centerEcef, aabb: m.aabb, minH: m.minH, maxH: m.maxH, skirtDepth: m.skirtDepth,
      },
      water: out.water
        ? { position: out.water.position, normal: out.water.normal, uv: out.water.uv, depth: out.water.depth, vertexCount: out.water.vertexCount, quads: out.water.quads, aabb: out.water.aabb }
        : null,
      heights: out.heights, heightsWidth: out.heightsWidth, imagery, waterFraction: out.waterFraction,
      elapsedMs: performance.now() - t0,
    };
    return { response, transfer };
  } catch (err) {
    if (imagery?.kind === 'bitmap') imagery.bitmap.close();
    if (isAbortError(err, signal)) return { response: { type: 'aborted', key: req.key }, transfer: [] };
    return {
      response: {
        type: 'error', key: req.key,
        message: err instanceof Error ? err.message : String(err),
        status: err instanceof HttpError ? err.status : undefined,
      },
      transfer: [],
    };
  }
}
