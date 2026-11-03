/**
 * Request transport: one module Web Worker (decode + build off the main thread) or, when
 * Worker is unavailable / fails to start / a fetch override is injected (tests), the same job
 * on the calling thread. A worker that dies fails over to the in-thread path and replays the
 * outstanding requests. Concurrency is limited by the caller (SceneryManager).
 */
import type { BuildRequest, WorkerResponse } from './protocol';
import { handleRequest, type FetchLike } from './workerCore';

export type LoaderMode = 'worker' | 'sync';

export interface LoaderOptions {
  /** force a mode; default: worker when available */
  mode?: LoaderMode;
  /** fetch override (implies the in-thread path) */
  fetch?: FetchLike;
  onResponse(r: WorkerResponse): void;
  /** create the worker (tests inject a fake) */
  createWorker?: () => WorkerLike;
}

export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent | Event) => void) | null;
}

const defaultFetch: FetchLike = (url) => fetch(url);

export class SceneryLoader {
  private _mode: LoaderMode;
  private worker: WorkerLike | null = null;
  private readonly outstanding = new Map<number, BuildRequest>();
  private readonly fetchFn: FetchLike;
  private disposed = false;
  private warned = false;

  constructor(private readonly opts: LoaderOptions) {
    this.fetchFn = opts.fetch ?? defaultFetch;
    const canWorker = typeof Worker !== 'undefined' || !!opts.createWorker;
    this._mode = opts.mode ?? (opts.fetch || !canWorker ? 'sync' : 'worker');
    if (this._mode === 'worker') this.startWorker();
  }

  get mode(): LoaderMode { return this._mode; }
  get inFlight(): number { return this.outstanding.size; }

  request(req: BuildRequest): void {
    if (this.disposed) return;
    this.outstanding.set(req.id, req);
    if (this._mode === 'worker' && this.worker) {
      try {
        this.worker.postMessage(req);
        return;
      } catch (e) {
        this.failover(e);
        return;
      }
    }
    this.runInThread(req);
  }

  /** Forget a request (its response, if any, is dropped). */
  cancel(id: number): void { this.outstanding.delete(id); }

  dispose(): void {
    this.disposed = true;
    this.outstanding.clear();
    try { this.worker?.terminate(); } catch { /* ignore */ }
    this.worker = null;
  }

  private startWorker(): void {
    try {
      const w = this.opts.createWorker ? this.opts.createWorker() : (new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike);
      w.onmessage = (ev: MessageEvent) => this.deliver(ev.data as WorkerResponse);
      w.onerror = (ev) => {
        if (typeof (ev as Event).preventDefault === 'function') (ev as Event).preventDefault();
        this.failover(ev);
      };
      this.worker = w;
    } catch (e) {
      this.failover(e);
    }
  }

  /** The worker failed: continue on the main thread and replay what was outstanding. */
  private failover(reason: unknown): void {
    if (this._mode === 'sync') return;
    if (!this.warned) {
      this.warned = true;
      console.warn('[scenery] worker unavailable, building tiles on the main thread:', reason instanceof Error ? reason.message : (reason as ErrorEvent)?.message ?? reason);
    }
    try { this.worker?.terminate(); } catch { /* ignore */ }
    this.worker = null;
    this._mode = 'sync';
    for (const req of [...this.outstanding.values()]) this.runInThread(req);
  }

  private runInThread(req: BuildRequest): void {
    void handleRequest(req, this.fetchFn).then((r) => this.deliver(r));
  }

  private deliver(r: WorkerResponse): void {
    if (this.disposed || !r || !this.outstanding.has(r.id)) return;
    this.outstanding.delete(r.id);
    try {
      this.opts.onResponse(r);
    } catch (e) {
      console.error('[scenery] tile handler failed:', e);
    }
  }
}
