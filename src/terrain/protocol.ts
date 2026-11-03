/**
 * Message contracts between TerrainSystem (main thread) and terrain.worker.ts. Plain data
 * only (structured-clone friendly); typed arrays and ImageBitmaps are transferred.
 */
import type { LocalFrameInfo, Vec3 } from '../core/types';
import type { ImageryCandidate } from './imagery';
import type { PavementFlatteningSpec } from './pavement';
import type { ProceduralParams } from './procedural';
import type { RunwayFlatteningSpec } from './runways';
import type { Aabb } from './tileMesh';

export interface ElevationSource {
  providerId: string;
  /** URL to fetch, or null for procedural generation */
  url: string | null;
  /** 'png' decodes with fast-png (bit exact, works in Node); 'webp' needs createImageBitmap */
  format: 'png' | 'webp' | 'none';
  tileSize: number;
  /** zoom of the data this source provides: the tile's own zoom, or an ancestor's for the parent fallback */
  zoom: number;
  /**
   * Parent-tile fallback: `url` is an ancestor `depth` levels up; upsample the sub-square at
   * offset (x, y) (in descendant tiles from the ancestor's NW corner) to the full tile size.
   */
  sub?: { depth: number; x: number; y: number };
}

export interface LoadRequest {
  type: 'load';
  key: string;
  z: number;
  x: number;
  y: number;
  /** elevation providers to try in order */
  elevation: ElevationSource[];
  /** imagery candidates to try in order (null url = procedural) */
  imagery: ImageryCandidate[];
  frame: LocalFrameInfo;
  quads: number;
  skirt: number;
  runways: RunwayFlatteningSpec[];
  /**
   * Airport pavement (aprons, taxiway areas, buffered taxiway centre lines) flattened before the
   * runways, only the areas touching this tile (none below PAVEMENT_MIN_ZOOM). Optional: absent = none.
   */
  pavement?: PavementFlatteningSpec[];
  procedural: ProceduralParams;
  /** keep the full-resolution height grid (z ≥ 11); otherwise a 4× box downsample is returned */
  fullHeights: boolean;
  /** build the ocean patch when the tile has sea-level cells */
  water: boolean;
  /**
   * After a network source failed transiently (offline, timeout, 5xx), fall back to procedural
   * heights (true, the default) or answer an `error` with `transient: true` (false) — set when
   * real data already covers the tile on the main thread, so synthetic terrain never replaces it.
   */
  proceduralOnTransient?: boolean;
}

export interface AbortRequest { type: 'abort'; key: string }
export interface ConfigRequest { type: 'config'; cacheName: string; cacheMaxEntries: number }
export type WorkerRequest = LoadRequest | AbortRequest | ConfigRequest;

export interface MeshPayload {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  height: Float32Array;
  vertexCount: number;
  quads: number;
  centerEcef: Vec3;
  aabb: Aabb;
  minH: number;
  maxH: number;
  skirtDepth: number;
}

export interface WaterPayload {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  depth: Float32Array;
  vertexCount: number;
  quads: number;
  aabb: Aabb;
}

export type ImageryPayload =
  /** fetched imagery tile (zI, x, y) of the provider; shared by every terrain tile below it */
  | { kind: 'bitmap'; providerId: string; zI: number; x: number; y: number; bitmap: ImageBitmap }
  | { kind: 'rgba'; providerId: string; zI: number; data: Uint8ClampedArray; width: number }
  | null;

export interface TileResponse {
  type: 'tile';
  key: string;
  z: number;
  x: number;
  y: number;
  frame: LocalFrameInfo;
  elevationProviderId: string;
  /** zoom of the elevation data actually used (< z when the parent-tile fallback answered) */
  elevationZoom: number;
  mesh: MeshPayload;
  water: WaterPayload | null;
  /**
   * The (flattened) DEM grid, full or 4× downsampled. Collision does not use it: TerrainSystem
   * stores the mesh's own vertex lattice (`mesh.height`) so wheels rest on the drawn triangles.
   */
  heights: Float32Array;
  heightsWidth: number;
  imagery: ImageryPayload;
  /** fraction of DEM cells at or below sea level */
  waterFraction: number;
  /** a better source failed for a transient reason (network, timeout, 5xx): the tile is worth reloading later */
  transientFailure: boolean;
  /** worker time, ms */
  elapsedMs: number;
}

export interface ErrorResponse {
  type: 'error';
  key: string;
  message: string;
  /** HTTP status when the failure was a response (404 → no data at this zoom) */
  status?: number;
  /** the failure was transient (network, timeout, 5xx): worth retrying soon */
  transient?: boolean;
}
export interface AbortedResponse { type: 'aborted'; key: string }
export type WorkerResponse = TileResponse | ErrorResponse | AbortedResponse;
