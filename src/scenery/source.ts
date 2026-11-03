/**
 * Vector tile source: resolves the tile URL template once per session from the OpenFreeMap
 * TileJSON (its tiles[0] carries a versioned path), or takes a full template override
 * (`?osm=` → SceneryHostOptions.tileUrl). A failed TileJSON is logged once and retried with
 * a long backoff; until then the scenery simply stays empty.
 */
import { OPENFREEMAP_TILEJSON } from './config';

export type FetchJson = (url: string) => Promise<unknown>;

export interface TileSourceOptions {
  /** full URL template with {z}/{x}/{y} (skips the TileJSON) */
  template?: string;
  tileJsonUrl?: string;
  fetchJson?: FetchJson;
  now?: () => number;
  log?: (msg: string) => void;
}

const defaultFetchJson: FetchJson = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

/** Shared per session (page): the TileJSON is fetched once even if the scenery is re-created. */
const sessionTemplates = new Map<string, Promise<{ template: string; maxZoom: number }>>();

export class TileSource {
  private template: string | null = null;
  private _maxZoom = 14;
  private state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private retryAt = 0;
  private attempts = 0;
  private readonly url: string;
  private readonly fetchJson: FetchJson;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private logged = false;
  private readonly waiters: ((t: string | null) => void)[] = [];

  constructor(opts: TileSourceOptions = {}) {
    this.url = opts.tileJsonUrl ?? OPENFREEMAP_TILEJSON;
    this.fetchJson = opts.fetchJson ?? defaultFetchJson;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((m) => console.warn(m));
    if (opts.template) {
      this.template = opts.template;
      this.state = 'ready';
    }
  }

  get maxZoom(): number { return this._maxZoom; }
  get ready(): boolean { return this.state === 'ready'; }
  get failed(): boolean { return this.state === 'failed'; }

  /** The URL template, or null while it is being resolved (starts / retries resolution). */
  get(): string | null {
    if (this.state === 'ready') return this.template;
    if (this.state === 'idle' || (this.state === 'failed' && this.now() >= this.retryAt && this.attempts < 6)) this.resolve();
    return null;
  }

  /** Wait for the template (null when the TileJSON failed or the wait timed out). */
  whenReady(timeoutMs = 15000): Promise<string | null> {
    const t = this.get();
    if (t || this.state === 'failed') return Promise.resolve(t);
    return new Promise((res) => {
      const timer = setTimeout(() => res(this.template), timeoutMs);
      this.waiters.push((v) => { clearTimeout(timer); res(v); });
    });
  }

  private resolve(): void {
    this.state = 'loading';
    this.attempts++;
    let p = sessionTemplates.get(this.url);
    if (!p) {
      p = this.fetchJson(this.url).then((j) => {
        const tj = j as { tiles?: unknown; maxzoom?: unknown };
        const t = Array.isArray(tj.tiles) && typeof tj.tiles[0] === 'string' ? (tj.tiles[0] as string) : null;
        if (!t || !t.includes('{z}')) throw new Error('TileJSON without a tiles[] template');
        const mz = typeof tj.maxzoom === 'number' && tj.maxzoom > 0 ? tj.maxzoom : 14;
        return { template: t, maxZoom: mz };
      });
      sessionTemplates.set(this.url, p);
    }
    p.then(({ template, maxZoom }) => {
      this.template = template;
      this._maxZoom = maxZoom;
      this.state = 'ready';
      this.flush(template);
    }, (e: unknown) => {
      sessionTemplates.delete(this.url);
      this.state = 'failed';
      this.retryAt = this.now() + 30000 * 2 ** Math.min(this.attempts - 1, 4);
      if (!this.logged) {
        this.logged = true;
        this.log(`[scenery] OSM tile source unavailable (${this.url}): ${e instanceof Error ? e.message : String(e)} — scenery disabled for now`);
      }
      this.flush(null);
    });
  }

  private flush(v: string | null): void {
    const w = this.waiters.splice(0);
    for (const f of w) f(v);
  }
}

/** Forget cached TileJSON templates (tests). */
export function resetTileSourceCache(): void { sessionTemplates.clear(); }
