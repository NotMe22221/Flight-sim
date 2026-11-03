/**
 * Main-thread side of the tile worker pool: a priority queue of load requests, a per-worker
 * in-flight cap, and cancellation with a grace period so that a turn which briefly drops a
 * tile from the selection does not thrash the network. Workers are injected (`createWorker`)
 * so the scheduling logic is unit-tested with fakes in Node.
 */
import type { ConfigRequest, ErrorResponse, LoadRequest, TileResponse, WorkerRequest, WorkerResponse } from './protocol';

export interface WorkerLike {
  postMessage(msg: WorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null;
  terminate(): void;
}

export interface WorkerPoolOptions {
  workers: number;
  /** concurrent loads per worker (§3.4: 4) */
  maxInFlightPerWorker: number;
  /** ms a released tile stays queued/in flight before it is cancelled (§3.4: 2 s) */
  cancelGraceMs: number;
  createWorker: () => WorkerLike;
  onTile: (r: TileResponse) => void;
  onError: (r: ErrorResponse) => void;
  onAborted?: (key: string) => void;
}

interface Entry {
  req: LoadRequest;
  priority: number;
  /** time the tile was last released by the selection, or -1 while wanted */
  releasedAt: number;
  worker: Slot | null;
  abortSent: boolean;
}

interface Slot { worker: WorkerLike; inFlight: Set<string> }

export class TerrainWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly entries = new Map<string, Entry>();
  private queue: Entry[] = [];
  private queueDirty = false;
  private disposed = false;
  private completed = 0;
  private failed = 0;
  private aborted = 0;

  constructor(private readonly opts: WorkerPoolOptions) {
    for (let i = 0; i < Math.max(1, opts.workers); i++) {
      const worker = opts.createWorker();
      const slot: Slot = { worker, inFlight: new Set() };
      worker.onmessage = (e) => this.onMessage(slot, e.data);
      this.slots.push(slot);
    }
  }

  /** Broadcast a configuration message to every worker. */
  configure(cfg: Omit<ConfigRequest, 'type'>): void {
    for (const s of this.slots) s.worker.postMessage({ type: 'config', ...cfg });
  }

  /** Queue a load (or refresh the priority of a queued one) and mark it wanted. Higher priority loads first. */
  request(req: LoadRequest, priority: number): void {
    const e = this.entries.get(req.key);
    if (e) {
      e.releasedAt = -1;
      if (e.priority !== priority) { e.priority = priority; if (!e.worker) this.queueDirty = true; }
      return;
    }
    const entry: Entry = { req, priority, releasedAt: -1, worker: null, abortSent: false };
    this.entries.set(req.key, entry);
    this.queue.push(entry);
    this.queueDirty = true;
  }

  /** The selection no longer needs this tile; it is cancelled after the grace period unless re-requested. */
  release(key: string, now: number): void {
    const e = this.entries.get(key);
    if (e && e.releasedAt < 0) e.releasedAt = now;
  }

  has(key: string): boolean { return this.entries.has(key); }
  isInFlight(key: string): boolean { return this.entries.get(key)?.worker !== null && this.entries.has(key); }
  get queued(): number { return this.queue.length; }
  get inFlight(): number { let n = 0; for (const s of this.slots) n += s.inFlight.size; return n; }
  get stats(): { queued: number; inFlight: number; completed: number; failed: number; aborted: number } {
    return { queued: this.queue.length, inFlight: this.inFlight, completed: this.completed, failed: this.failed, aborted: this.aborted };
  }

  /** Dispatch queued loads to free slots and cancel released ones past the grace period. Call once per frame. */
  pump(now: number): void {
    if (this.disposed) return;
    const grace = this.opts.cancelGraceMs;
    // Cancel released work past its grace.
    if (this.queue.some((e) => e.releasedAt >= 0 && now - e.releasedAt > grace)) {
      this.queue = this.queue.filter((e) => {
        if (e.releasedAt >= 0 && now - e.releasedAt > grace) { this.entries.delete(e.req.key); return false; }
        return true;
      });
    }
    for (const e of this.entries.values()) {
      if (e.worker && !e.abortSent && e.releasedAt >= 0 && now - e.releasedAt > grace) {
        e.abortSent = true;
        e.worker.worker.postMessage({ type: 'abort', key: e.req.key });
      }
    }
    if (this.queue.length === 0) return;
    if (this.queueDirty) { this.queue.sort((a, b) => b.priority - a.priority); this.queueDirty = false; }
    let next = 0;
    while (next < this.queue.length) {
      let best: Slot | null = null;
      for (const s of this.slots) if (s.inFlight.size < this.opts.maxInFlightPerWorker && (!best || s.inFlight.size < best.inFlight.size)) best = s;
      if (!best) break;
      const e = this.queue[next++];
      e.worker = best;
      best.inFlight.add(e.req.key);
      best.worker.postMessage(e.req);
    }
    if (next > 0) this.queue.splice(0, next);
  }

  private onMessage(slot: Slot, msg: WorkerResponse): void {
    const e = this.entries.get(msg.key);
    slot.inFlight.delete(msg.key);
    if (e && e.worker === slot) this.entries.delete(msg.key);
    switch (msg.type) {
      case 'tile': this.completed++; this.opts.onTile(msg); break;
      case 'error': this.failed++; this.opts.onError(msg); break;
      case 'aborted': this.aborted++; this.opts.onAborted?.(msg.key); break;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.slots) { s.worker.onmessage = null; s.worker.terminate(); }
    this.slots.length = 0;
    this.entries.clear();
    this.queue.length = 0;
  }
}
