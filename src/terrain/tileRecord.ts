/**
 * Main-thread bookkeeping of one tile (docs/research/03 §3.5): request state, versions for
 * reloads (runway or imagery changes), LRU stamps, its GPU objects and the float64 anchor
 * used for floating-origin rebasing.
 */
import { Vector3 } from 'three';
import type { Vec3 } from '../core/types';
import { tileToLonLat, tileWidthMeters } from '../geo/mercator';
import type { LocalFrame } from '../geo/wgs84';
import { RangeList, tileId } from './drawPlan';
import type { LoadRequest, TileResponse } from './protocol';
import type { TileGpu } from './tileGpu';

export interface TileRecord {
  readonly id: number;
  /** `z/x/y` */
  readonly key: string;
  readonly z: number;
  readonly x: number;
  readonly y: number;
  /** ground width of the tile at its centre latitude, m */
  readonly widthM: number;
  /** centre at h = 0 in the current render frame (priorities, frustum tests) */
  readonly center: Vector3;
  /** GPU objects; non-null ⇔ drawable */
  gpu: TileGpu | null;
  /** response received but not yet turned into GPU objects (upload budget) */
  pending: TileResponse | null;
  /** waiting in the upload queue */
  queued: boolean;
  /** heights are in the HeightField */
  hasData: boolean;
  /** outstanding pool request key ('' when none) and its request (kept to refresh priority) */
  reqKey: string;
  req: LoadRequest | null;
  /** data version wanted / requested / held — data is stale while have < want */
  wantVersion: number;
  reqVersion: number;
  haveVersion: number;
  /** last load failed (drawn by ancestors meanwhile) */
  failed: boolean;
  /** consecutive failed or degraded loads; next (re)load not before `retryAt` (ms) */
  failures: number;
  retryAt: number;
  /** LRU stamp (ms) and the selection / draw passes that last used the tile */
  lastUsed: number;
  wantedPass: number;
  drawPass: number;
  /** rebasing anchor: float64 ECEF centre and the frame the vertices were built in */
  centerEcef: Vec3 | null;
  buildFrame: LocalFrame | null;
  elevationProviderId: string;
  imageryProviderId: string;
  /** index ranges drawn this plan */
  readonly ranges: RangeList;
}

/** New idle record for tile (z, x, y); `frame` positions its centre. */
export function createTileRecord(z: number, x: number, y: number, frame: LocalFrame): TileRecord {
  const c = tileToLonLat(x + 0.5, y + 0.5, z);
  const p = frame.geodeticToThree(c.lat, c.lon, 0);
  return {
    id: tileId(z, x, y), key: `${z}/${x}/${y}`, z, x, y,
    widthM: tileWidthMeters(c.lat, z), center: new Vector3(p[0], p[1], p[2]),
    gpu: null, pending: null, queued: false, hasData: false,
    reqKey: '', req: null, wantVersion: 0, reqVersion: 0, haveVersion: -1,
    failed: false, failures: 0, retryAt: 0,
    lastUsed: 0, wantedPass: -1, drawPass: -1,
    centerEcef: null, buildFrame: null, elevationProviderId: '', imageryProviderId: '',
    ranges: new RangeList(),
  };
}

const _c: Vec3 = [0, 0, 0];

/** Recompute the record's render-frame centre after a rebase. */
export function updateRecordCenter(rec: TileRecord, frame: LocalFrame): void {
  const c = tileToLonLat(rec.x + 0.5, rec.y + 0.5, rec.z);
  frame.geodeticToThree(c.lat, c.lon, 0, _c);
  rec.center.set(_c[0], _c[1], _c[2]);
}

/** Close an ImageBitmap carried by a response that will never be uploaded. */
export function discardResponse(r: TileResponse | null): void {
  if (r?.imagery?.kind === 'bitmap') r.imagery.bitmap.close();
}
