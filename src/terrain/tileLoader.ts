/**
 * Request transport of the terrain system: owns the worker pool and decides how tiles load.
 *
 * - Browser: `navigator.hardwareConcurrency − 2` (2…4) Vite module workers running terrain.worker.ts.
 * - Node tests, an injected fetch, or `inThread: true`: one `InThreadWorker` running the same job.
 * - A module worker that fails to start (CSP, bundling problem) fails over to in-thread loading;
 *   outstanding requests are reported through `onReset` so the owner re-issues them.
 *
 * Callbacks are wrapped so that nothing thrown by a handler escapes into the pool or the loop.
 */
import { InThreadWorker } from './inThreadWorker';
import type { ErrorResponse, LoadRequest, TileResponse } from './protocol';
import { platformFetch, type FetchFn } from './tileFetch';
import { TerrainWorkerPool, type WorkerLike } from './workerPool';

export interface TileLoaderOptions {
  /** module workers to start (browser) */
  workers: number;
  /** load on the calling thread (forced when `fetch` is injected or `Worker` is missing) */
  inThread: boolean;
  /** network fetch override; implies in-thread loading */
  fetch?: FetchFn;
  /** ms a released request survives before it is cancelled */
  cancelGraceMs: number;
  onTile(r: TileResponse): void;
  onError(r: ErrorResponse): void;
  onAborted(key: string): void;
  /** every outstanding request was dropped (worker failover); re-request what is still needed */
  onReset(): void;
}

export type LoaderMode = 'worker' | 'in-thread';

/** Default worker count: hardwareConcurrency − 2, clamped to 2…4 (§3.4). */
export function defaultWorkerCount(): number {
  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  return Math.max(2, Math.min(4, hc - 2));
}

export class TileLoader {
  private pool: TerrainWorkerPool;
  private _mode: LoaderMode;
  private disposed = false;

  constructor(private readonly opts: TileLoaderOptions) {
    this._mode = opts.inThread || opts.fetch || typeof Worker === 'undefined' ? 'in-thread' : 'worker';
    this.pool = this.createPool();
  }

  /** How tiles are currently loaded. */
  get mode(): LoaderMode { return this._mode; }

  get stats(): { queued: number; inFlight: number; completed: number; failed: number; aborted: number } { return this.pool.stats; }

  /** Queue (or re-prioritise and un-release) a request. */
  request(req: LoadRequest, priority: number): void { if (!this.disposed) this.pool.request(req, priority); }
  /** The request is no longer needed; cancelled after the grace period unless re-requested. */
  release(key: string, now: number): void { if (!this.disposed) this.pool.release(key, now); }
  /** Is the request still queued or running? */
  has(key: string): boolean { return this.pool.has(key); }
  /** Dispatch queued requests and cancel expired ones. */
  pump(now: number): void { if (!this.disposed) this.pool.pump(now); }

  dispose(): void {
    this.disposed = true;
    this.pool.dispose();
  }

  private createPool(): TerrainWorkerPool {
    const inThread = this._mode === 'in-thread';
    const fetchFn = this.opts.fetch ?? platformFetch;
    const useCacheApi = this.opts.fetch === undefined;
    return new TerrainWorkerPool({
      workers: inThread ? 1 : this.opts.workers,
      maxInFlightPerWorker: inThread ? 8 : 4,
      cancelGraceMs: this.opts.cancelGraceMs,
      createWorker: inThread ? () => new InThreadWorker(fetchFn, useCacheApi) : () => this.createModuleWorker(),
      onTile: (r) => this.guard(() => this.opts.onTile(r)),
      onError: (r) => this.guard(() => this.opts.onError(r)),
      onAborted: (key) => this.guard(() => this.opts.onAborted(key)),
    });
  }

  private createModuleWorker(): WorkerLike {
    try {
      // Literal `new Worker(new URL(...), { type: 'module' })` so Vite bundles the worker.
      const w = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
      w.onerror = (e: ErrorEvent): void => { e.preventDefault(); this.failOver(e.message); };
      w.onmessageerror = (): void => this.failOver('message deserialisation failed');
      return w as unknown as WorkerLike;
    } catch (err) {
      console.warn('[terrain] module worker unavailable, loading tiles on the main thread', err);
      return new InThreadWorker(this.opts.fetch ?? platformFetch, this.opts.fetch === undefined);
    }
  }

  /** Replace the worker pool with in-thread loading after a worker failure. */
  private failOver(reason: string): void {
    if (this.disposed || this._mode === 'in-thread') return;
    console.warn(`[terrain] tile worker failed (${reason}); falling back to main-thread loading`);
    const old = this.pool;
    this._mode = 'in-thread';
    this.pool = this.createPool();
    old.dispose();
    this.guard(() => this.opts.onReset());
  }

  private guard(fn: () => void): void {
    if (this.disposed) return;
    try { fn(); } catch (err) { console.error('[terrain] tile callback threw', err); }
  }
}
