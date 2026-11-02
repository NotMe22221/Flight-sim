/**
 * 1°×1° grid index over geodetic points for nearest-N queries. Items are stored in parallel
 * arrays; each cell holds item indices. A query scans only the cells that can contain points
 * within the search radius (rows ordered outward from the centre so it can stop early), so the
 * cost is O(cells × items-per-cell), independent of the total item count.
 */
import type { Geodetic } from '../core/types';
import { greatCircleDistance } from '../geo/wgs84';

const D2R = Math.PI / 180;
/** metres per degree of latitude (and of longitude at the equator) */
export const M_PER_DEG = 111_195;

/** Result of a nearest query. */
export interface Neighbour<T> { item: T; distanceM: number }

export class SpatialGrid<T> {
  private readonly items: T[] = [];
  private readonly lats: number[] = [];
  private readonly lons: number[] = [];
  private readonly cells = new Map<number, number[]>();

  /** Number of indexed items. */
  get size(): number { return this.items.length; }

  /** Cell key for a position: lat rows −90..89, lon columns wrapped to −180..179. */
  static key(latCell: number, lonCell: number): number {
    const r = Math.min(Math.max(latCell, -90), 89) + 90;
    const c = ((lonCell + 180) % 360 + 360) % 360;
    return r * 360 + c;
  }

  /** Index a point. Returns its item index. */
  insert(item: T, lat: number, lon: number): number {
    const i = this.items.length;
    this.items.push(item); this.lats.push(lat); this.lons.push(lon);
    const k = SpatialGrid.key(Math.floor(lat), Math.floor(lon));
    let cell = this.cells.get(k);
    if (!cell) { cell = []; this.cells.set(k, cell); }
    cell.push(i);
    return i;
  }

  /** Item by index. */
  at(i: number): T { return this.items[i]; }

  /**
   * Up to `maxCount` items within `maxDistM` of `pos`, nearest first.
   * @param filter optional predicate on items (e.g. matching frequency)
   */
  nearest(pos: Geodetic, maxCount: number, maxDistM: number, filter?: (item: T) => boolean): Neighbour<T>[] {
    const out: Neighbour<T>[] = [];
    if (maxCount <= 0 || maxDistM <= 0) return out;
    const lat0 = Math.floor(pos.lat), lon0 = Math.floor(pos.lon);
    const latSpan = Math.min(Math.ceil(maxDistM / M_PER_DEG) + 1, 180);
    // Longitude cells shrink with cos(lat); use the largest |lat| in range for a safe span.
    const maxAbsLat = Math.min(89.99, Math.abs(pos.lat) + latSpan);
    const cosLat = Math.max(Math.cos(maxAbsLat * D2R), 1e-6);
    const lonSpan = Math.min(Math.ceil(maxDistM / (M_PER_DEG * cosLat)) + 1, 180);
    const scratch: Geodetic = { lat: 0, lon: 0, alt: 0 };

    for (let k = 0; k <= latSpan; k++) {
      // Rows at ±k (row 0 once).
      for (let s = k === 0 ? 1 : -1; s <= 1; s += 2) {
        const row = lat0 + s * k;
        if (row < -90 || row > 89) continue;
        for (let dc = -lonSpan; dc <= lonSpan; dc++) {
          const cell = this.cells.get(SpatialGrid.key(row, lon0 + dc));
          if (!cell) continue;
          for (let j = 0; j < cell.length; j++) {
            const i = cell[j];
            const item = this.items[i];
            if (filter && !filter(item)) continue;
            scratch.lat = this.lats[i]; scratch.lon = this.lons[i];
            const d = greatCircleDistance(pos, scratch);
            if (d > maxDistM) continue;
            insertSorted(out, item, d, maxCount);
          }
        }
      }
      // Every point in rows beyond ±k is more than k degrees of latitude away.
      if (out.length >= maxCount && out[out.length - 1].distanceM <= k * M_PER_DEG) break;
    }
    return out;
  }

  /** Iterate all items whose cell intersects the bounding box (coarse; no distance check). */
  forEachInBox(latMin: number, latMax: number, lonMin: number, lonMax: number, fn: (item: T, lat: number, lon: number) => void): void {
    const r0 = Math.floor(latMin), r1 = Math.floor(latMax);
    let c0 = Math.floor(lonMin), c1 = Math.floor(lonMax);
    if (c1 - c0 >= 360) { c0 = -180; c1 = 179; }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = this.cells.get(SpatialGrid.key(r, c));
        if (!cell) continue;
        for (const i of cell) fn(this.items[i], this.lats[i], this.lons[i]);
      }
    }
  }
}

/** Insert into a distance-sorted bounded array (small N, linear scan). */
function insertSorted<T>(arr: Neighbour<T>[], item: T, distanceM: number, max: number): void {
  if (arr.length >= max && distanceM >= arr[arr.length - 1].distanceM) return;
  let i = arr.length;
  while (i > 0 && arr[i - 1].distanceM > distanceM) i--;
  arr.splice(i, 0, { item, distanceM });
  if (arr.length > max) arr.length = max;
}
