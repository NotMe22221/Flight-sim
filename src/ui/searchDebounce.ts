/**
 * Debounced search for the World Map airport box. Pure logic with injectable timers so it is
 * testable without a DOM: normalises the query, skips repeats, drops results of superseded
 * (async) searches, and lets Enter flush the pending search immediately.
 */

export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Collapses whitespace and trims; '' when shorter than `minLength` characters. */
export function normalizeQuery(raw: string, minLength = 2): string {
  const q = (raw ?? '').replace(/\s+/g, ' ').trim();
  return q.length >= minLength ? q : '';
}

export interface DebouncedSearchOptions<T> {
  /** Runs the search (synchronous, or a promise for async back-ends). */
  search: (query: string) => T[] | Promise<T[]>;
  /** Receives the results of the newest query only. `query` is '' for a cleared box. */
  onResults: (query: string, results: T[]) => void;
  /** Called when a search throws/rejects (results are then reported as empty). */
  onError?: (query: string, err: unknown) => void;
  delayMs?: number;
  minLength?: number;
  timers?: TimerApi;
}

export class DebouncedSearch<T> {
  private handle: unknown = null;
  private pendingQuery = '';
  private lastRun: string | null = null;
  private seq = 0;
  private disposed = false;
  private readonly delayMs: number;
  private readonly minLength: number;
  private readonly timers: TimerApi;

  constructor(private readonly o: DebouncedSearchOptions<T>) {
    this.delayMs = o.delayMs ?? 180;
    this.minLength = o.minLength ?? 2;
    this.timers = o.timers ?? defaultTimers;
  }

  /** True while a search is scheduled but has not run yet. */
  get pending(): boolean { return this.handle !== null; }
  /** The last query that actually ran ('' after a clear, null before the first run). */
  get lastQuery(): string | null { return this.lastRun; }

  /** Call on every keystroke. */
  input(raw: string): void {
    if (this.disposed) return;
    const q = normalizeQuery(raw, this.minLength);
    if (q === '') {
      this.cancel();
      if (this.lastRun !== '') { this.lastRun = ''; this.seq++; this.o.onResults('', []); }
      return;
    }
    if (q === this.lastRun && this.handle === null) return; // unchanged (e.g. trailing space)
    this.pendingQuery = q;
    this.cancel();
    this.handle = this.timers.set(() => { this.handle = null; this.run(this.pendingQuery); }, this.delayMs);
  }

  /** Runs the scheduled search now (Enter key). Returns true if something ran. */
  flush(): boolean {
    if (this.handle === null) return false;
    this.cancel();
    this.run(this.pendingQuery);
    return true;
  }

  /** Forgets the scheduled search. */
  cancel(): void {
    if (this.handle !== null) { this.timers.clear(this.handle); this.handle = null; }
  }

  /** Forces the next identical query to run again (e.g. after the database loaded more data). */
  invalidate(): void { this.lastRun = null; }

  dispose(): void { this.cancel(); this.disposed = true; }

  private run(q: string): void {
    if (this.disposed) return;
    this.lastRun = q;
    const id = ++this.seq;
    let r: T[] | Promise<T[]>;
    try { r = this.o.search(q); } catch (e) { this.fail(q, e); return; }
    if (Array.isArray(r)) { this.o.onResults(q, r); return; }
    r.then((res) => { if (id === this.seq && !this.disposed) this.o.onResults(q, res); },
      (e: unknown) => { if (id === this.seq && !this.disposed) this.fail(q, e); });
  }

  private fail(q: string, e: unknown): void {
    this.o.onError?.(q, e);
    this.o.onResults(q, []);
  }
}
