/**
 * The job a scenery worker runs for one request: fetch the tile, decode it and build the
 * geometry. Shared by the module worker (worker.ts) and the in-thread fallback, so tests
 * exercise exactly the worker protocol.
 */
import { buildTile } from './builder';
import type { BuildRequest, FailureKind, WorkerResponse } from './protocol';

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (url: string) => Promise<FetchResponseLike>;

export type TileBytes = { bytes: Uint8Array } | { kind: FailureKind; status: number; message: string };

/** gunzip when a server hands out raw gzip without Content-Encoding (mbtiles dumps do). */
async function maybeGunzip(b: Uint8Array): Promise<Uint8Array> {
  if (b.length < 2 || b[0] !== 0x1f || b[1] !== 0x8b) return b;
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw new Error('gzip tile and no DecompressionStream');
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(new DS('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Fetch tile bytes; 204 / 404 / empty bodies are "empty", other failures are classified. */
export async function fetchTileBytes(url: string, fetchFn: FetchLike): Promise<TileBytes> {
  let res: FetchResponseLike;
  try {
    res = await fetchFn(url);
  } catch (e) {
    return { kind: 'network', status: 0, message: e instanceof Error ? e.message : String(e) };
  }
  if (res.status === 204 || res.status === 404) return { kind: 'empty', status: res.status, message: 'no tile' };
  if (!res.ok) return { kind: 'http', status: res.status, message: `HTTP ${res.status}` };
  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch (e) {
    return { kind: 'network', status: res.status, message: e instanceof Error ? e.message : String(e) };
  }
  if (buf.byteLength === 0) return { kind: 'empty', status: res.status, message: 'empty body' };
  try {
    return { bytes: await maybeGunzip(new Uint8Array(buf)) };
  } catch (e) {
    return { kind: 'decode', status: res.status, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Build a response for already fetched bytes (sync; the in-thread fallback and tests use it directly). */
export function buildResponse(req: BuildRequest, bytes: Uint8Array): WorkerResponse {
  try {
    const result = buildTile(bytes, req.z, req.x, req.y, req.settings, req.parkingOnly === true);
    result.key = req.key;
    return { type: 'built', id: req.id, key: req.key, result };
  } catch (e) {
    return { type: 'failed', id: req.id, key: req.key, kind: 'decode', status: 0, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Full job: fetch + decode + build. Never rejects. */
export async function handleRequest(req: BuildRequest, fetchFn: FetchLike): Promise<WorkerResponse> {
  try {
    const got = await fetchTileBytes(req.url, fetchFn);
    if (!('bytes' in got)) return { type: 'failed', id: req.id, key: req.key, kind: got.kind, status: got.status, message: got.message };
    return buildResponse(req, got.bytes);
  } catch (e) {
    return { type: 'failed', id: req.id, key: req.key, kind: 'decode', status: 0, message: e instanceof Error ? e.message : String(e) };
  }
}
