/**
 * Data contract between the tile builder (worker or in-thread) and the main thread.
 * Everything is typed arrays in the tile-local ENU frame (x = East, y = Up, z = South,
 * origin at the tile centre on the ellipsoid) so results transfer without copies.
 * Vertical positions are relative to the ground: the main thread adds the terrain height.
 */
import type { PavementArea } from '../world/pavement';
import type { BuildSettings } from './config';

/** One merged mesh. `color` is normalised RGB (3 bytes per vertex). */
export interface MeshData {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array | null;
  color: Uint8Array | null;
  index: Uint32Array;
}

/** Ground samples stored per building (centroid + up to 4 footprint points). */
export const BUILDING_SAMPLES = 5;

export interface BuildingsData {
  /** walls with windows (residential / commercial) */
  walls: MeshData;
  /** walls without windows (industrial, warehouses, hangars) and gable ends of plain buildings */
  plain: MeshData;
  /** flat and pitched roofs */
  roofs: MeshData;
  /** per building: [wallStart, wallCount, plainStart, plainCount, roofStart, roofCount] in vertices */
  ranges: Uint32Array;
  /** per building: BUILDING_SAMPLES (x, z) ground sample points, local metres (centroid first) */
  samples: Float32Array;
  /** per building: how many of its samples to use (1 = centroid only, for small footprints) */
  sampleCount: Uint8Array;
  /** per building: footprint centroid (x, z) */
  centroids: Float32Array;
  /** index count of the important buildings at the start of each index buffer [walls, plain, roofs] */
  bigIndexCount: Uint32Array;
  count: number;
}

/** A surface draped on the terrain: vertex y = ground + lift. */
export interface DrapedData {
  mesh: MeshData;
  /** per-vertex lift above the ground (m) */
  lift: Float32Array;
}

/** Point lights: y = ground + height. */
export interface PointsData {
  /** x, z per point */
  xz: Float32Array;
  /** height above ground per point */
  height: Float32Array;
  /** normalised RGB per point (intensity baked in) */
  color: Uint8Array;
  count: number;
}

/** Tree instances: x, z, height (m), rotation (rad) per tree; colour per tree. */
export interface TreesData {
  conifer: Float32Array;
  coniferColor: Uint8Array;
  broadleaf: Float32Array;
  broadleafColor: Uint8Array;
  count: number;
}

export interface ParkingSpotLocal {
  /** local metres */
  x: number;
  z: number;
  /** true heading of the aircraft nose (deg) in the tile frame */
  headingDeg: number;
  name: string;
  kind: 'gate' | 'stand';
}

export interface TileStats {
  buildings: number;
  trees: number;
  lights: number;
  triangles: number;
}

export interface TileBuildResult {
  key: string;
  z: number;
  x: number;
  y: number;
  buildings: BuildingsData | null;
  /** aprons, taxiway polygons and taxiway ribbons */
  surfaces: DrapedData | null;
  /** yellow taxiway centre-line markings */
  markings: DrapedData | null;
  trees: TreesData | null;
  streetlights: PointsData | null;
  /** taxiway edge (blue), centre-line (green) and apron flood lights */
  airportLights: PointsData | null;
  /** apron floodlight pools (night decals) */
  lightPools: DrapedData | null;
  parking: ParkingSpotLocal[];
  /** airport pavement in lon/lat for terrain flattening (also in parking-only builds) */
  pavement: PavementArea[];
  stats: TileStats;
  /** features skipped as malformed */
  decodeErrors: number;
  buildMs: number;
}

export interface BuildRequest {
  type: 'build';
  id: number;
  key: string;
  z: number;
  x: number;
  y: number;
  url: string;
  settings: BuildSettings;
  /** only extract parking spots (no geometry) */
  parkingOnly?: boolean;
}

export type FailureKind = 'empty' | 'http' | 'network' | 'decode';

export interface BuiltResponse { type: 'built'; id: number; key: string; result: TileBuildResult }
export interface FailedResponse { type: 'failed'; id: number; key: string; kind: FailureKind; status: number; message: string }
export type WorkerResponse = BuiltResponse | FailedResponse;
export type WorkerRequest = BuildRequest;

/** Every ArrayBuffer of a result (transfer list). */
export function transferables(r: TileBuildResult): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (a: ArrayBufferView | null | undefined) => { if (a && a.buffer instanceof ArrayBuffer) out.add(a.buffer); };
  const mesh = (m: MeshData | null | undefined) => { if (!m) return; add(m.position); add(m.normal); add(m.uv); add(m.color); add(m.index); };
  if (r.buildings) {
    const b = r.buildings;
    mesh(b.walls); mesh(b.plain); mesh(b.roofs);
    add(b.ranges); add(b.samples); add(b.sampleCount); add(b.centroids); add(b.bigIndexCount);
  }
  for (const d of [r.surfaces, r.markings, r.lightPools]) if (d) { mesh(d.mesh); add(d.lift); }
  if (r.trees) { add(r.trees.conifer); add(r.trees.coniferColor); add(r.trees.broadleaf); add(r.trees.broadleafColor); }
  for (const p of [r.streetlights, r.airportLights]) if (p) { add(p.xz); add(p.height); add(p.color); }
  return [...out];
}
