import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lonLatToTile } from '../geo/mercator';
import { HeightField } from './heightfield';
import type { LoadRequest, TileResponse } from './protocol';
import { DEFAULT_IMAGERY_CHAIN, awsTerrarium } from './providers';
import { buildLoadRequest, elevationSources, type RequestConfig } from './requests';
import { decodeTerrariumPng } from './terrarium';
import { TileCache, type FetchFn } from './tileFetch';
import { createProceduralCache, runTileJob, type TileJobContext } from './tileJob';

const KSFO = { lat: 37.613538, lon: -122.35716 };
const AWS = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const z12 = new Uint8Array(readFileSync(new URL('./__fixtures__/terrarium-12-655-1585.png', import.meta.url)));
const z15 = new Uint8Array(readFileSync(new URL('./__fixtures__/terrarium-15-5246-12684.png', import.meta.url)));

const cfg: RequestConfig = {
  elevation: [awsTerrarium], imagery: DEFAULT_IMAGERY_CHAIN, parentFallbackLevels: 3, proceduralTileSize: 64,
  quadsPerLevel: [64, 32], finestZoom: 15, procedural: { seed: 7 },
};
const frame = { lat0: KSFO.lat, lon0: KSFO.lon, alt0: 0 };

function ctxWith(fetchFn: FetchFn): TileJobContext {
  return { cache: new TileCache('test', 10, fetchFn, false), canDecodeBitmaps: false, procedural: createProceduralCache() };
}
const serve = (files: Record<string, Uint8Array>, log: string[] = []): FetchFn => async (url) => {
  log.push(url);
  const b = files[url];
  return b ? new Response(b.slice()) : new Response(null, { status: 404 });
};
const req = (z: number, x: number, y: number): LoadRequest => buildLoadRequest(`${z}/${x}/${y}@0`, z, x, y, frame, cfg, []);

describe('request building', () => {
  it('elevation chain: own tile, three ancestors with sub-square offsets, then procedural', () => {
    const src = elevationSources(cfg, 15, 5246, 12684);
    expect(src.map((s) => s.url)).toEqual([
      `${AWS}/15/5246/12684.png`, `${AWS}/14/2623/6342.png`, `${AWS}/13/1311/3171.png`, `${AWS}/12/655/1585.png`, null,
    ]);
    expect(src[3].sub).toEqual({ depth: 3, x: 5246 & 7, y: 12684 & 7 });
    expect(src[4]).toMatchObject({ providerId: 'procedural', format: 'none', tileSize: 64 });
  });

  it('zooms finer than the provider serves come from its finest ancestor', () => {
    const src = elevationSources({ ...cfg, finestZoom: 17 }, 17, 20987, 50739);
    expect(src[0].url).toBe(`${AWS}/15/${20987 >> 2}/${50739 >> 2}.png`);
    expect(src[0].sub).toEqual({ depth: 2, x: 20987 & 3, y: 50739 & 3 });
    expect(src.length).toBe(2); // no extra parent levels below the provider's max zoom, then procedural
  });

  it('per-level quads, skirt depth and runway filtering', () => {
    const near = { a: { lat: KSFO.lat, lon: KSFO.lon, elev: 4 }, b: { lat: 37.6287, lon: -122.3932, elev: 3 }, halfWidthM: 60, featherM: 150 };
    const far = { a: { lat: 47.26, lon: 11.34, elev: 580 }, b: { lat: 47.26, lon: 11.37, elev: 581 }, halfWidthM: 60, featherM: 150 };
    const r = buildLoadRequest('k', 15, 5246, 12684, frame, cfg, [near, far]);
    expect(r.quads).toBe(64);
    expect(r.runways).toEqual([near]);
    expect(r.skirt).toBeGreaterThanOrEqual(10);
    expect(buildLoadRequest('k', 13, 1311, 3171, frame, cfg, []).quads).toBe(32);
    expect(r.fullHeights).toBe(true);
    expect(buildLoadRequest('k', 9, 81, 198, frame, cfg, []).fullHeights).toBe(false);
  });
});

describe('runTileJob (the worker job, run in Node)', () => {
  it('own tile present: decodes it bit-exactly, procedural imagery when no bitmap decoder', async () => {
    const { response } = await runTileJob(req(15, 5246, 12684), new AbortController().signal, ctxWith(serve({ [`${AWS}/15/5246/12684.png`]: z15 })));
    expect(response.type).toBe('tile');
    const r = response as TileResponse;
    expect(r.elevationZoom).toBe(15);
    expect(r.imagery?.kind).toBe('rgba');
    const hf = new HeightField(15);
    hf.set(15, 5246, 12684, r.heights, r.heightsWidth);
    expect(hf.heightAt(KSFO.lon, KSFO.lat)!).toBeCloseTo(3.96, 1);
  });

  it('parent fallback: a missing z15 tile is cut from the z12 ancestor and agrees with it', async () => {
    const log: string[] = [];
    const { response } = await runTileJob(req(15, 5246, 12684), new AbortController().signal, ctxWith(serve({ [`${AWS}/12/655/1585.png`]: z12 }, log)));
    const r = response as TileResponse;
    expect(r.type).toBe('tile');
    expect(r.elevationProviderId).toBe('aws-terrarium');
    expect(r.elevationZoom).toBe(12);
    expect(log.filter((u) => u.includes('terrarium')).length).toBe(4);
    const hf = new HeightField(15);
    hf.set(15, 5246, 12684, r.heights, r.heightsWidth);
    const parent = new HeightField(15);
    const t = lonLatToTile(KSFO.lon, KSFO.lat, 12);
    expect(Math.floor(t.x)).toBe(655);
    parent.set(12, 655, 1585, decodeTerrariumPng(z12).heights, 256);
    expect(hf.heightAt(KSFO.lon, KSFO.lat)!).toBeCloseTo(parent.heightAt(KSFO.lon, KSFO.lat)!, 1);
  });

  it('everything missing: procedural heights (never an error)', async () => {
    const { response } = await runTileJob(req(15, 5246, 12684), new AbortController().signal, ctxWith(serve({})));
    expect(response.type).toBe('tile');
    expect((response as TileResponse).elevationProviderId).toBe('procedural');
    expect((response as TileResponse).heightsWidth).toBe(64);
  });

  it('an aborted signal yields an aborted response', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { response } = await runTileJob(req(15, 5246, 12684), ctrl.signal, ctxWith(serve({})));
    expect(response).toEqual({ type: 'aborted', key: '15/5246/12684@0' });
  });
});

describe('runTileJob network robustness', () => {
  it('a hanging server times out into the fallbacks and flags the tile for a later retry', async () => {
    const hang: FetchFn = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
    const ctx: TileJobContext = { cache: new TileCache('t', 10, hang, false, 30), canDecodeBitmaps: false, procedural: createProceduralCache() };
    const t0 = performance.now();
    const { response } = await runTileJob(req(15, 5246, 12684), new AbortController().signal, ctx);
    expect(performance.now() - t0).toBeLessThan(2000); // one 30 ms timeout (the ancestors share the host), not forever
    expect(response.type).toBe('tile');
    expect((response as TileResponse).elevationProviderId).toBe('procedural');
    expect((response as TileResponse).transientFailure).toBe(true);
  });

  it('with real data covering the tile, an outage is reported as a transient error, not synthetic heights', async () => {
    const offline: FetchFn = async () => { throw new TypeError('Failed to fetch'); };
    const r = buildLoadRequest('k', 15, 5246, 12684, frame, cfg, [], false);
    expect(r.proceduralOnTransient).toBe(false);
    const { response } = await runTileJob(r, new AbortController().signal, ctxWith(offline));
    expect(response).toMatchObject({ type: 'error', key: 'k', transient: true });
    // a 404 chain still falls back to procedural heights (definitive: no data exists)
    const { response: r404 } = await runTileJob(r, new AbortController().signal, ctxWith(serve({})));
    expect(r404.type).toBe('tile');
  });

  it('404s are definitive: procedural fallback without a retry flag', async () => {
    const { response } = await runTileJob(req(15, 5246, 12684), new AbortController().signal, ctxWith(serve({})));
    expect((response as TileResponse).transientFailure).toBe(false);
  });
});
