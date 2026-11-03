/**
 * A `WorkerLike` that runs tile jobs on the calling thread. Used where module workers are
 * unavailable (Node tests, very old browsers, a worker that failed to load). Runs exactly the
 * same `runTileJob` as terrain.worker.ts, with an injectable fetch.
 */
import type { WorkerRequest, WorkerResponse } from './protocol';
import { TileCache, platformFetch, type FetchFn } from './tileFetch';
import { createProceduralCache, runTileJob, type TileJobContext } from './tileJob';
import type { WorkerLike } from './workerPool';

export class InThreadWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  private readonly inflight = new Map<string, AbortController>();
  private readonly ctx: TileJobContext;
  private terminated = false;

  /**
   * @param fetchFn network fetch (tests inject a fixture server)
   * @param useCacheApi use the browser Cache API when present (false for injected fetches)
   */
  constructor(private readonly fetchFn: FetchFn = platformFetch, private readonly useCacheApi = true) {
    this.ctx = {
      cache: new TileCache('terrain-v1', 6000, fetchFn, useCacheApi),
      canDecodeBitmaps: typeof createImageBitmap === 'function',
      procedural: createProceduralCache(),
    };
  }

  /** Number of jobs currently running. */
  get running(): number { return this.inflight.size; }

  postMessage(msg: WorkerRequest): void {
    if (this.terminated) return;
    switch (msg.type) {
      case 'load': void this.load(msg); break;
      case 'abort': this.inflight.get(msg.key)?.abort(); break;
      case 'config': this.ctx.cache = new TileCache(msg.cacheName, msg.cacheMaxEntries, this.fetchFn, this.useCacheApi); break;
    }
  }

  private async load(req: Extract<WorkerRequest, { type: 'load' }>): Promise<void> {
    const ctrl = new AbortController();
    this.inflight.set(req.key, ctrl);
    await Promise.resolve(); // never answer synchronously from inside postMessage
    const { response } = await runTileJob(req, ctrl.signal, this.ctx);
    this.inflight.delete(req.key);
    if (this.terminated) return;
    try {
      this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
    } catch (err) {
      console.error('[terrain] tile handler threw', err);
    }
  }

  terminate(): void {
    this.terminated = true;
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
    this.onmessage = null;
  }
}
