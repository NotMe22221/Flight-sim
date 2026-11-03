/**
 * Terrain tile worker (Vite module worker). A thin shell around `runTileJob` (tileJob.ts):
 * one `load` message per tile, `abort` cancels it at the next await, `config` swaps the
 * response cache. Results are posted back with their buffers / ImageBitmaps transferred.
 */
import type { WorkerRequest, WorkerResponse } from './protocol';
import { TileCache } from './tileFetch';
import { createProceduralCache, runTileJob, type TileJobContext } from './tileJob';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const inflight = new Map<string, AbortController>();
const ctx: TileJobContext = {
  cache: new TileCache('terrain-v1', 6000),
  canDecodeBitmaps: typeof createImageBitmap === 'function',
  procedural: createProceduralCache(),
};

/** Post a response; whatever happens, the main thread gets an answer for `msg.key` (or it would wait forever). */
const post = (msg: WorkerResponse, transfer: Transferable[]): void => {
  try {
    scope.postMessage(msg, transfer);
    return;
  } catch { /* e.g. a buffer listed twice: try a copy */ }
  try {
    scope.postMessage(msg);
    return;
  } catch { /* not cloneable */ }
  scope.postMessage({ type: 'error', key: msg.key, message: 'tile response could not be posted' } satisfies WorkerResponse);
};

scope.onmessage = (e: MessageEvent<WorkerRequest>): void => {
  const msg = e.data;
  switch (msg.type) {
    case 'load': {
      const ctrl = new AbortController();
      inflight.set(msg.key, ctrl);
      void runTileJob(msg, ctrl.signal, ctx).then(
        ({ response, transfer }) => { inflight.delete(msg.key); post(response, transfer); },
        (err: unknown) => { inflight.delete(msg.key); post({ type: 'error', key: msg.key, message: String(err) }, []); },
      );
      break;
    }
    case 'abort': inflight.get(msg.key)?.abort(); break;
    case 'config': ctx.cache = new TileCache(msg.cacheName, msg.cacheMaxEntries); break;
  }
};
