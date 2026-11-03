/**
 * Terrain tile worker (Vite module worker). One message per tile: fetch + decode the DEM
 * (with provider fallbacks), flatten runways, build the curved mesh and ocean patch, fetch
 * imagery, and post everything back with transferables. Aborts are honoured at every await.
 */
import { ProceduralTerrain, type ProceduralParams } from './procedural';
import type { ElevationSource, LoadRequest, TileResponse, WorkerRequest, WorkerResponse } from './protocol';
import { HttpError, TileCache, decodeElevationResponse, fetchImageryBitmap } from './tileFetch';
import { runTilePipeline } from './tilePipeline';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const inflight = new Map<string, AbortController>();
let cache = new TileCache('terrain-v1', 6000);
let procedural: { key: string; gen: ProceduralTerrain } | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []): void => ctx.postMessage(msg, transfer);

function proceduralFor(params: ProceduralParams): ProceduralTerrain {
  const key = JSON.stringify(params);
  if (!procedural || procedural.key !== key) procedural = { key, gen: new ProceduralTerrain(params) };
  return procedural.gen;
}

const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError';
const throwIfAborted = (signal: AbortSignal): void => { if (signal.aborted) throw new DOMException('aborted', 'AbortError'); };

async function loadElevation(req: LoadRequest, signal: AbortSignal): Promise<{ heights: Float32Array; width: number; providerId: string }> {
  let lastError: unknown = new Error('no elevation source');
  for (const src of req.elevation) {
    throwIfAborted(signal);
    try {
      if (src.url === null || src.format === 'none') {
        const t = proceduralFor(req.procedural).heightsTile(req.z, req.x, req.y, src.tileSize);
        return { heights: t.heights, width: src.tileSize, providerId: src.providerId };
      }
      const res = await cache.fetch(src.url, signal);
      const d = await decodeElevationResponse(res, src.format, src.tileSize);
      return { heights: d.heights, width: d.width, providerId: src.providerId };
    } catch (err) {
      if (isAbort(err)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

async function loadImagery(req: LoadRequest, heights: Float32Array, width: number, signal: AbortSignal): Promise<TileResponse['imagery']> {
  for (const c of req.imagery) {
    throwIfAborted(signal);
    try {
      if (c.url === null) {
        const data = proceduralFor(req.procedural).imageryTile(heights, width, req.z, req.x, req.y);
        return { kind: 'rgba', providerId: c.providerId, zI: req.z, data, width };
      }
      const bitmap = await fetchImageryBitmap(cache, c.url, signal);
      return { kind: 'bitmap', providerId: c.providerId, zI: c.zI, bitmap };
    } catch (err) {
      if (isAbort(err)) throw err;
    }
  }
  return null;
}

async function load(req: LoadRequest): Promise<void> {
  const ctrl = new AbortController();
  inflight.set(req.key, ctrl);
  const t0 = performance.now();
  try {
    const dem = await loadElevation(req, ctrl.signal);
    const out = runTilePipeline({
      z: req.z, x: req.x, y: req.y, heights: dem.heights, width: dem.width, frame: req.frame,
      quads: req.quads, skirt: req.skirt, runways: req.runways, fullHeights: req.fullHeights, water: req.water,
    });
    const imagery = await loadImagery(req, dem.heights, dem.width, ctrl.signal);
    throwIfAborted(ctrl.signal);
    const m = out.mesh;
    const transfer: Transferable[] = [m.position.buffer, m.normal.buffer, m.uv.buffer, m.height.buffer];
    if (out.water) transfer.push(out.water.position.buffer, out.water.normal.buffer, out.water.uv.buffer, out.water.depth.buffer);
    if (!transfer.includes(out.heights.buffer)) transfer.push(out.heights.buffer);
    if (imagery?.kind === 'bitmap') transfer.push(imagery.bitmap);
    else if (imagery?.kind === 'rgba') transfer.push(imagery.data.buffer);
    const msg: TileResponse = {
      type: 'tile', key: req.key, z: req.z, x: req.x, y: req.y, frame: req.frame, elevationProviderId: dem.providerId,
      mesh: { position: m.position, normal: m.normal, uv: m.uv, height: m.height, vertexCount: m.vertexCount, quads: m.quads, centerEcef: m.centerEcef, aabb: m.aabb, minH: m.minH, maxH: m.maxH, skirtDepth: m.skirtDepth },
      water: out.water ? { position: out.water.position, normal: out.water.normal, uv: out.water.uv, depth: out.water.depth, vertexCount: out.water.vertexCount, quads: out.water.quads, aabb: out.water.aabb } : null,
      heights: out.heights, heightsWidth: out.heightsWidth, imagery, waterFraction: out.waterFraction, elapsedMs: performance.now() - t0,
    };
    post(msg, transfer);
  } catch (err) {
    if (isAbort(err)) post({ type: 'aborted', key: req.key });
    else post({ type: 'error', key: req.key, message: err instanceof Error ? err.message : String(err), status: err instanceof HttpError ? err.status : undefined });
  } finally {
    inflight.delete(req.key);
  }
}

ctx.onmessage = (e: MessageEvent<WorkerRequest>): void => {
  const msg = e.data;
  switch (msg.type) {
    case 'load': void load(msg); break;
    case 'abort': inflight.get(msg.key)?.abort(); break;
    case 'config': cache = new TileCache(msg.cacheName, msg.cacheMaxEntries); break;
  }
};
