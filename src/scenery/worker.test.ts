import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { qualityProfile } from './config';
import { SceneryLoader, type WorkerLike } from './loader';
import { transferables, type BuildRequest, type WorkerResponse } from './protocol';
import { fetchTileBytes, handleRequest, type FetchLike } from './workerCore';
import { tileBytesAt } from './testUtil';

const settings = qualityProfile('medium').build;
const t = tileBytesAt(37.615867, -122.393443);
const req = (id: number, url = 'http://x/tile.pbf', extra: Partial<BuildRequest> = {}): BuildRequest => ({ type: 'build', id, key: `${t.z}/${t.x}/${t.y}`, z: t.z, x: t.x, y: t.y, url, settings, ...extra });
const serve = (body: Uint8Array | null, status = 200): FetchLike => async () => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => (body ? body.slice().buffer : new ArrayBuffer(0)) });

describe('worker protocol (sync path)', () => {
  it('fetches, decodes and builds a tile; the result transfers without copies', async () => {
    const r = await handleRequest(req(7), serve(t.bytes));
    expect(r.type).toBe('built');
    if (r.type !== 'built') return;
    expect(r.id).toBe(7);
    expect(r.result.key).toBe(`${t.z}/${t.x}/${t.y}`);
    expect(r.result.buildings!.count).toBeGreaterThan(0);
    const bufs = transferables(r.result);
    expect(new Set(bufs).size).toBe(bufs.length);
    expect(bufs.length).toBeGreaterThan(10);
    const posBuf = r.result.buildings!.walls.position.buffer;
    expect(bufs).toContain(posBuf);
    // transferring detaches every buffer and the clone keeps the data
    const clone = structuredClone(r, { transfer: bufs }) as WorkerResponse;
    expect(posBuf.byteLength).toBe(0);
    if (clone.type === 'built') expect(clone.result.buildings!.walls.position.length).toBeGreaterThan(0);
  });

  it('parking-only requests skip the geometry', async () => {
    const r = await handleRequest(req(8, 'u', { parkingOnly: true }), serve(t.bytes));
    expect(r.type).toBe('built');
    if (r.type !== 'built') return;
    expect(r.result.buildings).toBeNull();
    expect(r.result.parking.length).toBeGreaterThan(0);
  });

  it('classifies failures: 204 / 404 / empty body are empty tiles, 5xx http, throws network, garbage decode', async () => {
    const kind = async (f: FetchLike) => { const r = await handleRequest(req(1), f); return r.type === 'failed' ? `${r.kind}:${r.status}` : 'built'; };
    expect(await kind(serve(null, 204))).toBe('empty:204');
    expect(await kind(serve(null, 404))).toBe('empty:404');
    expect(await kind(serve(new Uint8Array(0), 200))).toBe('empty:200');
    expect(await kind(serve(null, 503))).toBe('http:503');
    expect(await kind(async () => { throw new TypeError('Failed to fetch (CORS)'); })).toBe('network:0');
    expect(await kind(async () => ({ ok: true, status: 200, arrayBuffer: async () => { throw new Error('aborted'); } }))).toBe('network:200');
    expect(await kind(serve(new Uint8Array([0x1a, 0xff, 0xff, 0xff, 0x0f, 1, 2])))).toBe('decode:0');
  });

  it('gunzips tiles served raw-gzipped', async () => {
    const got = await fetchTileBytes('u', serve(new Uint8Array(gzipSync(t.bytes))));
    expect('bytes' in got && got.bytes.length).toBe(t.bytes.length);
  });
});

/** A fake module worker running the real job in-process (or failing on demand). */
class FakeWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent | Event) => void) | null = null;
  posted = 0;
  terminated = false;
  constructor(private readonly fetchFn: FetchLike, private readonly failAfter = Infinity) {}
  postMessage(msg: unknown): void {
    this.posted++;
    if (this.posted > this.failAfter) {
      setTimeout(() => this.onerror?.(new Event('error')), 0);
      return;
    }
    void handleRequest(msg as BuildRequest, this.fetchFn).then((r) => this.onmessage?.({ data: r } as MessageEvent));
  }
  terminate(): void { this.terminated = true; }
}

describe('SceneryLoader', () => {
  it('uses the worker when available and delivers responses once', async () => {
    const w = new FakeWorker(serve(t.bytes));
    const got: WorkerResponse[] = [];
    const l = new SceneryLoader({ mode: 'worker', createWorker: () => w, onResponse: (r) => got.push(r) });
    expect(l.mode).toBe('worker');
    l.request(req(1));
    expect(l.inFlight).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(got.map((g) => g.type)).toEqual(['built']);
    expect(l.inFlight).toBe(0);
    l.dispose();
    expect(w.terminated).toBe(true);
  });

  it('fails over to the in-thread path when the worker dies and replays outstanding requests', async () => {
    const w = new FakeWorker(serve(t.bytes), 1);
    const got: WorkerResponse[] = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      const l = new SceneryLoader({ mode: 'worker', createWorker: () => w, fetch: undefined, onResponse: (r) => got.push(r) });
      (l as unknown as { fetchFn: FetchLike }).fetchFn = serve(t.bytes);
      l.request(req(1));
      l.request(req(2));
      await new Promise((r) => setTimeout(r, 80));
      expect(l.mode).toBe('sync');
      expect(got.map((g) => g.id).sort()).toEqual([1, 2]);
      l.dispose();
    } finally { console.warn = warn; }
  });

  it('falls back to the in-thread path when the worker cannot be created, and drops cancelled requests', async () => {
    const got: WorkerResponse[] = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      const l = new SceneryLoader({ mode: 'worker', createWorker: () => { throw new Error('CSP'); }, onResponse: (r) => got.push(r) });
      expect(l.mode).toBe('sync');
      (l as unknown as { fetchFn: FetchLike }).fetchFn = serve(t.bytes);
      l.request(req(5));
      l.cancel(5);
      l.request(req(6));
      await new Promise((r) => setTimeout(r, 50));
      expect(got.map((g) => g.id)).toEqual([6]);
    } finally { console.warn = warn; }
  });
});
