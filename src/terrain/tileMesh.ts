/**
 * Tile mesh construction (docs/research/03 §3.3, §4.3). Pure: runs in the worker and in Node.
 *
 * Every vertex goes tile fraction → lon/lat → bilinear DEM height → WGS84 ECEF → local
 * Three.js frame (x East, y Up, z South), all in float64, and is stored as float32 relative to
 * the tile centre. Earth curvature therefore falls out for free (−785 m at 100 km), and the
 * float32 values stay small (|p| ≲ tile half-diagonal) so GPU precision is never an issue.
 *
 * Vertex layout matches gridIndex.ts: (N+1)² grid vertices, then 6·(N+1) skirt vertices
 * (top, bottom, left, right edges, then the vertical and horizontal midlines) pushed down
 * along the local geodetic vertical.
 */
import { clamp } from '../core/math';
import type { LocalFrameInfo, Vec3 } from '../core/types';
import { tileToLonLat, tileWidthMeters } from '../geo/mercator';
import { LocalFrame, geodeticToEcef } from '../geo/wgs84';
import { gridVertexCount, tileVertexCount } from './gridIndex';
import { bilinearSample } from './sampling';

export interface Aabb { min: Vec3; max: Vec3 }

export interface TileMeshBuffers {
  /** xyz per vertex, metres, relative to `centerThree`, in the build frame's axes */
  position: Float32Array;
  /** unit normals in the build frame's axes */
  normal: Float32Array;
  /** u east 0..1, v 1 at the north edge → 0 at the south edge (matches a flipped image texture) */
  uv: Float32Array;
  /** DEM height (m) of each vertex — skirt vertices carry their edge height */
  height: Float32Array;
  vertexCount: number;
  quads: number;
  /** float64 ECEF position of the tile centre at the reference height; the anchor for rebasing */
  centerEcef: Vec3;
  /** float64 position of the centre in the build frame */
  centerThree: Vec3;
  /** box containing all vertices, relative to the centre (includes skirts) */
  aabb: Aabb;
  minH: number;
  maxH: number;
  /** skirt depth used (m) */
  skirtDepth: number;
}

export interface WaterPatchBuffers {
  /** grid-only vertices (no skirt) at h = 0 on the ellipsoid, relative to the same centre as the terrain tile */
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  /** terrain height under each vertex (≤ 0 in the sea) for depth colouring */
  depth: Float32Array;
  vertexCount: number;
  quads: number;
  aabb: Aabb;
}

/** Skirt depth per §3.3: 5 % of the tile width, clamped to 10…400 m. */
export const skirtDepthFor = (z: number, latDeg: number): number => clamp(0.05 * tileWidthMeters(latDeg, z), 10, 400);

/** Reference height of the tile centre: midpoint of the height range keeps |position| symmetric. */
export const tileCenterHeight = (minH: number, maxH: number): number => 0.5 * (minH + maxH);

/** ECEF (float64) of the tile centre at height h — the rebasing anchor. */
export function tileCenterEcef(z: number, x: number, y: number, h: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const c = tileToLonLat(x + 0.5, y + 0.5, z);
  return geodeticToEcef(c.lat, c.lon, h, out);
}

const asFrame = (f: LocalFrameInfo | LocalFrame): LocalFrame => (f instanceof LocalFrame ? f : new LocalFrame(f.lat0, f.lon0, f.alt0));

/** Reusable float64 scratch per grid size (the worker builds tiles sequentially). */
interface Scratch { pos: Float64Array; lons: Float64Array; lats: Float64Array; sinLat: Float64Array; cosLat: Float64Array; sinLon: Float64Array; cosLon: Float64Array }
const scratchCache = new Map<number, Scratch>();
function scratchFor(quads: number): Scratch {
  let s = scratchCache.get(quads);
  if (!s) {
    const W = quads + 1;
    s = { pos: new Float64Array(W * W * 3), lons: new Float64Array(W), lats: new Float64Array(W), sinLat: new Float64Array(W), cosLat: new Float64Array(W), sinLon: new Float64Array(W), cosLon: new Float64Array(W) };
    scratchCache.set(quads, s);
  }
  return s;
}

const D2R = Math.PI / 180;
const A = 6378137, E2 = 6.69437999014e-3;
const ecef = new Float64Array(3);

/** Fill per-column lon and per-row lat tables (and their trig) for tile (z,x,y) with W samples. */
function fillLonLat(z: number, x: number, y: number, W: number, s: Scratch): void {
  const N = W - 1;
  for (let i = 0; i < W; i++) {
    const ll = tileToLonLat(x + i / N, y + i / N, z);
    s.lons[i] = ll.lon; s.lats[i] = ll.lat;
    const la = ll.lat * D2R, lo = ll.lon * D2R;
    s.sinLat[i] = Math.sin(la); s.cosLat[i] = Math.cos(la);
    s.sinLon[i] = Math.sin(lo); s.cosLon[i] = Math.cos(lo);
  }
}

/** geodeticToEcef with precomputed trig (hot loop). */
function ecefFromTrig(sinLat: number, cosLat: number, sinLon: number, cosLon: number, h: number, out: Float64Array): void {
  const Nr = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  out[0] = (Nr + h) * cosLat * cosLon;
  out[1] = (Nr + h) * cosLat * sinLon;
  out[2] = (Nr * (1 - E2) + h) * sinLat;
}

/** ECEF → frame Three coords (float64), written to out3 at offset o. */
function toThree(frame: LocalFrame, p: Float64Array, out3: Float64Array, o: number): void {
  const dx = p[0] - frame.origin[0], dy = p[1] - frame.origin[1], dz = p[2] - frame.origin[2];
  const e = frame.east[0] * dx + frame.east[1] * dy + frame.east[2] * dz;
  const n = frame.north[0] * dx + frame.north[1] * dy + frame.north[2] * dz;
  const u = frame.up[0] * dx + frame.up[1] * dy + frame.up[2] * dz;
  out3[o] = e; out3[o + 1] = u; out3[o + 2] = -n;
}

/** Vertex normals of a W×W grid of float64 positions by central differences of the curved surface. */
function gridNormals(pos: Float64Array, W: number, normal: Float32Array): void {
  for (let j = 0; j < W; j++) {
    const jm = j > 0 ? j - 1 : 0, jp = j < W - 1 ? j + 1 : W - 1;
    for (let i = 0; i < W; i++) {
      const im = i > 0 ? i - 1 : 0, ip = i < W - 1 ? i + 1 : W - 1;
      const e0 = (j * W + im) * 3, e1 = (j * W + ip) * 3, s0 = (jm * W + i) * 3, s1 = (jp * W + i) * 3;
      const tex = pos[e1] - pos[e0], tey = pos[e1 + 1] - pos[e0 + 1], tez = pos[e1 + 2] - pos[e0 + 2];
      const tsx = pos[s1] - pos[s0], tsy = pos[s1 + 1] - pos[s0 + 1], tsz = pos[s1 + 2] - pos[s0 + 2];
      // normal = south × east (x east, y up, z south → z × x = +y)
      let nx = tsy * tez - tsz * tey, ny = tsz * tex - tsx * tez, nz = tsx * tey - tsy * tex;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const o = (j * W + i) * 3;
      normal[o] = nx; normal[o + 1] = ny; normal[o + 2] = nz;
    }
  }
}

function expandAabb(aabb: Aabb, x: number, y: number, z: number): void {
  if (x < aabb.min[0]) aabb.min[0] = x; if (x > aabb.max[0]) aabb.max[0] = x;
  if (y < aabb.min[1]) aabb.min[1] = y; if (y > aabb.max[1]) aabb.max[1] = y;
  if (z < aabb.min[2]) aabb.min[2] = z; if (z > aabb.max[2]) aabb.max[2] = z;
}
const emptyAabb = (): Aabb => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

/**
 * Build the terrain mesh of tile (z, x, y) from a `heightsWidth`² DEM grid (row 0 north).
 * `quads` must be a power of two (the shared index of gridIndex.ts is used to draw it).
 */
export function buildTileMesh(
  z: number, x: number, y: number,
  heights: ArrayLike<number>, heightsWidth: number,
  frameInfo: LocalFrameInfo | LocalFrame,
  quads: number,
  skirtDepth: number,
): TileMeshBuffers {
  const frame = asFrame(frameInfo);
  const N = quads, W = N + 1, G = gridVertexCount(N), V = tileVertexCount(N);
  const s = scratchFor(N);
  fillLonLat(z, x, y, W, s);
  const position = new Float32Array(V * 3), normal = new Float32Array(V * 3), uv = new Float32Array(V * 2), height = new Float32Array(V);

  // Heights at the grid vertices, min/max.
  let minH = Infinity, maxH = -Infinity;
  const pxScale = heightsWidth / N;
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const h = bilinearSample(heights, heightsWidth, heightsWidth, i * pxScale, j * pxScale);
      height[j * W + i] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }

  // Centre anchor.
  const hC = tileCenterHeight(minH, maxH);
  const centerEcef = tileCenterEcef(z, x, y, hC);
  const centerThree = frame.ecefToThree(centerEcef);

  // Grid positions (float64) → relative float32.
  const pos = s.pos;
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      ecefFromTrig(s.sinLat[j], s.cosLat[j], s.sinLon[i], s.cosLon[i], height[k], ecef);
      toThree(frame, ecef, pos, k * 3);
    }
  }
  gridNormals(pos, W, normal);
  const aabb = emptyAabb();
  for (let k = 0; k < G; k++) {
    const px = Math.fround(pos[k * 3] - centerThree[0]), py = Math.fround(pos[k * 3 + 1] - centerThree[1]), pz = Math.fround(pos[k * 3 + 2] - centerThree[2]);
    position[k * 3] = px; position[k * 3 + 1] = py; position[k * 3 + 2] = pz;
    expandAabb(aabb, px, py, pz);
    const i = k % W, j = (k - i) / W;
    uv[k * 2] = i / N; uv[k * 2 + 1] = 1 - j / N;
  }

  // Skirts: copies of the edge vertices lowered along the geodetic vertical; edge normal/uv/height.
  const skirtVertex = (dst: number, i: number, j: number): void => {
    const src = j * W + i;
    const h = height[src];
    ecefFromTrig(s.sinLat[j], s.cosLat[j], s.sinLon[i], s.cosLon[i], h - skirtDepth, ecef);
    toThree(frame, ecef, pos, 0); // reuse slot 0 of the float64 scratch (grid is already consumed)
    const px = Math.fround(pos[0] - centerThree[0]), py = Math.fround(pos[1] - centerThree[1]), pz = Math.fround(pos[2] - centerThree[2]);
    position[dst * 3] = px; position[dst * 3 + 1] = py; position[dst * 3 + 2] = pz;
    expandAabb(aabb, px, py, pz);
    normal[dst * 3] = normal[src * 3]; normal[dst * 3 + 1] = normal[src * 3 + 1]; normal[dst * 3 + 2] = normal[src * 3 + 2];
    uv[dst * 2] = uv[src * 2]; uv[dst * 2 + 1] = uv[src * 2 + 1];
    height[dst] = h;
  };
  for (let i = 0; i < W; i++) {
    skirtVertex(G + i, i, 0);          // top (north)
    skirtVertex(G + W + i, i, N);      // bottom (south)
  }
  for (let j = 0; j < W; j++) {
    skirtVertex(G + 2 * W + j, 0, j);  // left (west)
    skirtVertex(G + 3 * W + j, N, j);  // right (east)
  }
  // midline skirts: the interior borders of quadrants drawn as CDLOD parent patches
  const half = N >> 1;
  for (let j = 0; j < W; j++) skirtVertex(G + 4 * W + j, half, j); // vertical midline (i = N/2)
  for (let i = 0; i < W; i++) skirtVertex(G + 5 * W + i, i, half); // horizontal midline (j = N/2)

  return { position, normal, uv, height, vertexCount: V, quads: N, centerEcef, centerThree, aabb, minH, maxH, skirtDepth };
}

/**
 * Build the ocean patch of tile (z, x, y): the same N-quad grid at h = 0 on the ellipsoid
 * (curved like the terrain), no skirt, positioned relative to `centerEcef` of the terrain
 * tile so both share one object matrix. `depth` carries the terrain height under each vertex.
 */
export function buildWaterPatch(
  z: number, x: number, y: number,
  heights: ArrayLike<number>, heightsWidth: number,
  frameInfo: LocalFrameInfo | LocalFrame,
  quads: number,
  centerEcef: Vec3,
): WaterPatchBuffers {
  const frame = asFrame(frameInfo);
  const N = quads, W = N + 1, G = gridVertexCount(N);
  const s = scratchFor(N);
  fillLonLat(z, x, y, W, s);
  const centerThree = frame.ecefToThree(centerEcef);
  const position = new Float32Array(G * 3), normal = new Float32Array(G * 3), uv = new Float32Array(G * 2), depth = new Float32Array(G);
  const pos = s.pos;
  const pxScale = heightsWidth / N;
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      ecefFromTrig(s.sinLat[j], s.cosLat[j], s.sinLon[i], s.cosLon[i], 0, ecef);
      toThree(frame, ecef, pos, k * 3);
      depth[k] = bilinearSample(heights, heightsWidth, heightsWidth, i * pxScale, j * pxScale);
    }
  }
  gridNormals(pos, W, normal);
  const aabb = emptyAabb();
  for (let k = 0; k < G; k++) {
    const px = Math.fround(pos[k * 3] - centerThree[0]), py = Math.fround(pos[k * 3 + 1] - centerThree[1]), pz = Math.fround(pos[k * 3 + 2] - centerThree[2]);
    position[k * 3] = px; position[k * 3 + 1] = py; position[k * 3 + 2] = pz;
    expandAabb(aabb, px, py, pz);
    const i = k % W, j = (k - i) / W;
    uv[k * 2] = i / N; uv[k * 2 + 1] = 1 - j / N;
  }
  return { position, normal, uv, depth, vertexCount: G, quads: N, aabb };
}
