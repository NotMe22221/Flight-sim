/**
 * Resident DEM store and height queries (docs/research/03 §8). Pure, no Three.js.
 *
 * `sample()` walks from the finest zoom down and returns the height of the first tile that
 * covers the point, so collision always uses the best data available and never a hole.
 *
 * A tile holds either a DEM grid (`layout: 'pixels'`, pixel-is-area, sampled bilinearly) or —
 * what TerrainSystem stores — the vertex lattice of the tile mesh that is actually drawn
 * (`layout: 'mesh'`), sampled on the mesh's own triangles. The mesh interpolates its
 * (N+1)² vertices linearly, which differs from a bilinear sample of the 256² DEM by up to
 * ~1 m at N = 128 and ~10 m at N = 64 on hilly z12 tiles; with the lattice, wheels rest
 * exactly on the drawn surface. Heights are already runway-flattened by the worker.
 */
import type { Vec3 } from '../core/types';
import { MAX_LAT, metersPerPixel, tileKey } from '../geo/mercator';
import { tileId } from './drawPlan';
import { bilinearGradient, bilinearSample, triangleGradient, triangleSample } from './sampling';

/** 'pixels': DEM grid, pixel centres at +0.5, bilinear. 'mesh': (N+1)² mesh vertex lattice, triangle-interpolated. */
export type HeightLayout = 'pixels' | 'mesh';

export interface ResidentTile {
  key: string;
  /** numeric id (drawPlan.tileId) used as the map key — lookups allocate no strings */
  id: number;
  z: number;
  x: number;
  y: number;
  /** `width`² heights, metres, row 0 = north */
  heights: Float32Array;
  /** grid width: DEM pixels per side, or quads + 1 for a mesh lattice */
  width: number;
  layout: HeightLayout;
  minH: number;
  maxH: number;
  /** stamp from the last `touch()` for LRU eviction */
  lastUsed: number;
}

export interface HeightSample {
  /** metres (DEM datum) */
  h: number;
  /** zoom of the tile that answered */
  z: number;
  tile: ResidentTile | null;
}

const D2R = Math.PI / 180;

export class HeightField {
  private readonly tiles = new Map<number, ResidentTile>();
  /** number of resident tiles per zoom so the finest-first search skips empty levels */
  private readonly zoomCounts = new Int32Array(32);
  private readonly grad = new Float64Array(2);
  private readonly range = new Float64Array(2);
  private readonly sampleOut: HeightSample = { h: 0, z: -1, tile: null };

  constructor(public readonly maxZoom = 15, public readonly minZoom = 0) {}

  get size(): number { return this.tiles.size; }

  /** Store (or replace) a tile's DEM grid (pixel-is-area, bilinear). `minH`/`maxH` are computed when omitted. */
  set(z: number, x: number, y: number, heights: Float32Array, width: number, minH?: number, maxH?: number, now = 0): ResidentTile {
    if (heights.length !== width * width) throw new Error(`HeightField.set: ${heights.length} heights for width ${width}`);
    return this.store(z, x, y, heights, width, 'pixels', minH, maxH, now);
  }

  /**
   * Store (or replace) the vertex lattice of a tile's drawn mesh: `(quads+1)²` heights, vertex
   * (i, j) at tile fraction (i/quads, j/quads), row 0 = north (the grid part of
   * `TileMeshBuffers.height`). Queries then follow the mesh triangles exactly.
   */
  setMeshLattice(z: number, x: number, y: number, lattice: Float32Array, quads: number, minH?: number, maxH?: number, now = 0): ResidentTile {
    if (!(quads >= 1) || lattice.length !== (quads + 1) * (quads + 1)) throw new Error(`HeightField.setMeshLattice: ${lattice.length} heights for ${quads} quads`);
    return this.store(z, x, y, lattice, quads + 1, 'mesh', minH, maxH, now);
  }

  private store(z: number, x: number, y: number, heights: Float32Array, width: number, layout: HeightLayout, minH: number | undefined, maxH: number | undefined, now: number): ResidentTile {
    if (minH === undefined || maxH === undefined) {
      minH = Infinity; maxH = -Infinity;
      for (let i = 0; i < heights.length; i++) { const h = heights[i]; if (h < minH) minH = h; if (h > maxH) maxH = h; }
    }
    const id = tileId(z, x, y);
    const existing = this.tiles.get(id);
    if (!existing) this.zoomCounts[z]++;
    const tile: ResidentTile = { key: existing ? existing.key : tileKey(z, x, y), id, z, x, y, heights, width, layout, minH, maxH, lastUsed: now };
    this.tiles.set(id, tile);
    return tile;
  }

  get(z: number, x: number, y: number): ResidentTile | undefined { return this.tiles.get(tileId(z, x, y)); }
  getByKey(key: string): ResidentTile | undefined { const id = idOfKey(key); return id < 0 ? undefined : this.tiles.get(id); }
  has(z: number, x: number, y: number): boolean { return this.tiles.has(tileId(z, x, y)); }

  delete(z: number, x: number, y: number): boolean { return this.deleteId(tileId(z, x, y)); }
  deleteKey(key: string): boolean { const id = idOfKey(key); return id >= 0 && this.deleteId(id); }
  private deleteId(id: number): boolean {
    const t = this.tiles.get(id);
    if (!t) return false;
    this.tiles.delete(id);
    this.zoomCounts[t.z]--;
    return true;
  }
  clear(): void { this.tiles.clear(); this.zoomCounts.fill(0); }

  /** Mark a tile as used at `now` (LRU bookkeeping). */
  touch(tile: ResidentTile, now: number): void { tile.lastUsed = now; }

  /** Iterate resident tiles. */
  values(): IterableIterator<ResidentTile> { return this.tiles.values(); }

  /**
   * Finest-first height at (lon, lat): bilinear on a DEM grid, on the drawn triangles for a
   * mesh lattice. Returns the shared scratch sample (copy if you keep it) or null when no
   * resident tile covers the point. Allocation-free.
   */
  sample(lonDeg: number, latDeg: number): HeightSample | null {
    const n = 2 ** this.maxZoom;
    const lat = (latDeg > MAX_LAT ? MAX_LAT : latDeg < -MAX_LAT ? -MAX_LAT : latDeg) * D2R;
    let txMax = ((lonDeg + 180) / 360) * n;
    txMax -= Math.floor(txMax / n) * n; // wrap longitude
    const tyMax = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n;
    for (let z = this.maxZoom; z >= this.minZoom; z--) {
      if (this.zoomCounts[z] === 0) continue;
      const scale = 2 ** (z - this.maxZoom);
      const tx = txMax * scale, ty = tyMax * scale;
      const xi = Math.floor(tx), yi = Math.floor(ty);
      const tile = this.tiles.get(tileId(z, xi, yi));
      if (!tile) continue;
      const w = tile.width;
      const out = this.sampleOut;
      out.h = tile.layout === 'mesh'
        ? triangleSample(tile.heights, w - 1, tx - xi, ty - yi)
        : bilinearSample(tile.heights, w, w, (tx - xi) * w, (ty - yi) * w);
      out.z = z;
      out.tile = tile;
      return out;
    }
    return null;
  }

  /** Height at (lon, lat) from the finest resident tile, or null. */
  heightAt(lonDeg: number, latDeg: number): number | null {
    const s = this.sample(lonDeg, latDeg);
    return s ? s.h : null;
  }

  /**
   * Surface gradient at (lon, lat): out[0] = ∂h/∂east, out[1] = ∂h/∂north (m/m) from the
   * finest resident tile. Returns false (out untouched) when no tile covers the point.
   */
  gradient(lonDeg: number, latDeg: number, out: Float64Array | number[]): boolean {
    const s = this.sample(lonDeg, latDeg);
    if (!s || !s.tile) return false;
    const tile = s.tile, w = tile.width, n = 2 ** tile.z;
    const lat = (latDeg > MAX_LAT ? MAX_LAT : latDeg < -MAX_LAT ? -MAX_LAT : latDeg) * D2R;
    let tx = ((lonDeg + 180) / 360) * n;
    tx -= Math.floor(tx / n) * n;
    const ty = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n;
    let mpp: number;
    if (tile.layout === 'mesh') {
      // face slope of the drawn triangle; one quad = tileWidth / quads ground metres
      triangleGradient(tile.heights, w - 1, tx - tile.x, ty - tile.y, this.grad);
      mpp = metersPerPixel(latDeg, tile.z, w - 1);
    } else {
      bilinearGradient(tile.heights, w, w, (tx - tile.x) * w, (ty - tile.y) * w, this.grad);
      mpp = metersPerPixel(latDeg, tile.z, w);
    }
    out[0] = this.grad[0] / mpp;
    out[1] = -this.grad[1] / mpp; // image rows increase southward
    return true;
  }

  /** Unit surface normal in local ENU (east, north, up) at (lon, lat), or null. */
  normalENU(lonDeg: number, latDeg: number, out: Vec3): Vec3 | null {
    if (!this.gradient(lonDeg, latDeg, this.grad)) return null;
    const gx = this.grad[0], gy = this.grad[1];
    const inv = 1 / Math.sqrt(1 + gx * gx + gy * gy);
    out[0] = -gx * inv; out[1] = -gy * inv; out[2] = inv;
    return out;
  }

  /**
   * Height range of tile (z, x, y) from itself or its nearest resident ancestor. Writes
   * [min, max] to `out` and returns the zoom of the source tile, or -1 when none is resident.
   */
  heightRange(z: number, x: number, y: number, out: Float64Array | number[] = this.range): number {
    for (let zz = z, xx = x, yy = y; zz >= this.minZoom; zz--, xx >>= 1, yy >>= 1) {
      if (this.zoomCounts[zz] === 0) continue;
      const t = this.tiles.get(tileId(zz, xx, yy));
      if (t) { out[0] = t.minH; out[1] = t.maxH; return zz; }
    }
    return -1;
  }

  /** Nearest resident ancestor (or the tile itself), or undefined. */
  nearestResident(z: number, x: number, y: number): ResidentTile | undefined {
    for (let zz = z, xx = x, yy = y; zz >= this.minZoom; zz--, xx >>= 1, yy >>= 1) {
      if (this.zoomCounts[zz] === 0) continue;
      const t = this.tiles.get(tileId(zz, xx, yy));
      if (t) return t;
    }
    return undefined;
  }

  /**
   * Evict least-recently-used tiles until at most `maxTiles` remain, skipping tiles for
   * which `isProtected` returns true. Returns the evicted tiles (caller frees GPU resources).
   */
  evictLRU(maxTiles: number, isProtected?: (t: ResidentTile) => boolean): ResidentTile[] {
    const evicted: ResidentTile[] = [];
    const excess = this.tiles.size - maxTiles;
    if (excess <= 0) return evicted;
    const candidates: ResidentTile[] = [];
    for (const t of this.tiles.values()) if (!isProtected || !isProtected(t)) candidates.push(t);
    candidates.sort((a, b) => a.lastUsed - b.lastUsed);
    for (let i = 0; i < candidates.length && evicted.length < excess; i++) {
      this.deleteId(candidates[i].id);
      evicted.push(candidates[i]);
    }
    return evicted;
  }
}

/** Parse a `z/x/y` key into its tile id, or -1 when malformed. */
function idOfKey(key: string): number {
  const parts = key.split('/');
  if (parts.length !== 3) return -1;
  const z = Number(parts[0]), x = Number(parts[1]), y = Number(parts[2]);
  return Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y) && z >= 0 && x >= 0 && y >= 0 ? tileId(z, x, y) : -1;
}
