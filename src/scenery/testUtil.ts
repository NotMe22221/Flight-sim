/**
 * Test helpers (imported only by *.test.ts): synthetic tiles, fake fetch, flat / sloped ground.
 */
import * as THREE from 'three';
import { LocalFrame } from '../geo/wgs84';
import { lonLatToTile } from '../geo/mercator';
import { buildSyntheticWorld, encodeWorldTile, type SyntheticWorld } from './dev/syntheticWorld';
import type { SceneryHostOptions } from '../app/plugins';
import type { FetchLike, FetchResponseLike } from './workerCore';

let worldCache: SyntheticWorld | null = null;
export const syntheticWorld = (): SyntheticWorld => (worldCache ??= buildSyntheticWorld());

/** Fetch that serves the synthetic KSFO world at `http://fixtures/{z}/{x}/{y}.pbf`. */
export function worldFetch(opts: { fail?: (url: string) => 'network' | number | null; delayMs?: number; log?: string[] } = {}): FetchLike {
  const world = syntheticWorld();
  const cache = new Map<string, Uint8Array | null>();
  return async (url: string): Promise<FetchResponseLike> => {
    opts.log?.push(url);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const f = opts.fail?.(url) ?? null;
    if (f === 'network') throw new TypeError('Failed to fetch');
    if (typeof f === 'number') return { ok: f >= 200 && f < 300, status: f, arrayBuffer: async () => new ArrayBuffer(0) };
    const m = /(\d+)\/(\d+)\/(\d+)\.pbf/.exec(url);
    if (!m) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const key = `${m[1]}/${m[2]}/${m[3]}`;
    let bytes = cache.get(key);
    if (bytes === undefined) { bytes = encodeWorldTile(world, +m[1], +m[2], +m[3]); cache.set(key, bytes); }
    if (!bytes) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const b = bytes;
    return { ok: true, status: 200, arrayBuffer: async () => b.slice().buffer };
  };
}

/** Bytes of one synthetic tile (z14) containing lat/lon. */
export function tileBytesAt(lat: number, lon: number, z = 14): { bytes: Uint8Array; x: number; y: number; z: number } {
  const t = lonLatToTile(lon, lat, z);
  const x = Math.floor(t.x), y = Math.floor(t.y);
  const bytes = encodeWorldTile(syntheticWorld(), z, x, y);
  if (!bytes) throw new Error('no synthetic tile there');
  return { bytes, x, y, z };
}

/** Terrain as a function of geodetic position (MSL metres). */
export type HeightFn = (lat: number, lon: number) => number;

/** Host options with a terrain defined geodetically, so groundUp is consistent across frames. */
export function makeHost(frame: LocalFrame, height: HeightFn | null, extra: Partial<SceneryHostOptions> = {}): SceneryHostOptions & { setFrame(f: LocalFrame): void; setHeight(h: HeightFn | null): void; calls: number } {
  let fr = frame;
  let hf = height;
  const g = { lat: 0, lon: 0, alt: 0 };
  const host = {
    parent: new THREE.Group(),
    frame,
    calls: 0,
    depthMode: 'reversed',
    quality: 'high' as const,
    groundUp(n: number, e: number): number | null {
      host.calls++;
      if (!hf) return null;
      fr.nedToGeodetic(n, e, 0, g);
      const h = hf(g.lat, g.lon);
      // up coordinate of a point at MSL height h below (n, e): tangent-plane drop + height
      const p = fr.geodeticToNED(g.lat, g.lon, h);
      return -p[2];
    },
    heightAt(lat: number, lon: number): number | null { return hf ? hf(lat, lon) : null; },
    setFrame(f: LocalFrame) { fr = f; host.frame = f; },
    setHeight(h: HeightFn | null) { hf = h; },
    ...extra,
  };
  return host;
}

export const KSFO_FRAME = (): LocalFrame => new LocalFrame(37.613538, -122.35716, 0);
