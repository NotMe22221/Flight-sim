/**
 * "Never holes" coverage planning (docs/research/03 §3.2): maps every node of a CDLOD
 * selection to the tile mesh that draws it this frame. Pure and allocation-free after warm-up.
 *
 * For each selected node, in order of preference:
 *  1. `self`     — the intended tile is ready: the node's own tile, or for a parent patch the
 *                  parent's mesh restricted to the node's quadrant;
 *  2. `child`    — finer stand-ins: the node's own tile (for a parent patch) or all four of
 *                  its children (typical right after a merge, before the coarser tile arrives);
 *  3. `ancestor` — the nearest ready ancestor, restricted to the node's area;
 *  4. otherwise the node is a hole (only possible before the first tiles arrive).
 */
import { descendantCode } from './gridIndex';
import type { SelectedNode } from './quadtree';

export type DrawKind = 'self' | 'child' | 'ancestor';

export interface DrawItem {
  /** tile whose mesh draws this item */
  z: number;
  x: number;
  y: number;
  /** sub-square of that tile: 0 = whole tile, else levels below it with Morton path `code` (gridIndex.descendantCode) */
  depth: number;
  code: number;
  kind: DrawKind;
  /** index in the selection of the node this item covers */
  node: number;
}

/** Does tile (z, x, y) have GPU data ready to draw? */
export type ReadyFn = (z: number, x: number, y: number) => boolean;

/** Integer id of tile (z, x, y), unique for z ≤ 31 and x, y < 2^22: a Map key without string allocation. */
export const tileId = (z: number, x: number, y: number): number => (z * 4194304 + y) * 4194304 + x;

export class DrawPlanner {
  private readonly pool: DrawItem[] = [];
  private readonly out: DrawItem[] = [];
  /** nodes of the last plan with nothing ready to draw them */
  holes = 0;
  /** nodes of the last plan drawn at their intended level of detail */
  exact = 0;

  /** Items of the last plan (reused on the next call). */
  get items(): readonly DrawItem[] { return this.out; }

  /**
   * Plan the draws for `selection`. `minZoom` bounds the ancestor search. The returned array
   * and its records are reused by the next call.
   */
  plan(selection: readonly SelectedNode[], ready: ReadyFn, minZoom: number): readonly DrawItem[] {
    this.out.length = 0;
    this.holes = 0;
    this.exact = 0;
    for (let i = 0; i < selection.length; i++) {
      const s = selection[i];
      const tz = s.parentPatch ? s.z - 1 : s.z;
      const tx = s.parentPatch ? s.x >> 1 : s.x;
      const ty = s.parentPatch ? s.y >> 1 : s.y;
      const tDepth = s.z - tz;
      if (ready(tz, tx, ty)) {
        this.push(tz, tx, ty, tDepth, tDepth > 0 ? descendantCode(tz, s.z, s.x, s.y) : 0, 'self', i);
        this.exact++;
        continue;
      }
      if (s.parentPatch && ready(s.z, s.x, s.y)) { this.push(s.z, s.x, s.y, 0, 0, 'child', i); continue; }
      const cz = s.z + 1, cx = s.x * 2, cy = s.y * 2;
      if (ready(cz, cx, cy) && ready(cz, cx + 1, cy) && ready(cz, cx, cy + 1) && ready(cz, cx + 1, cy + 1)) {
        for (let q = 0; q < 4; q++) this.push(cz, cx + (q & 1), cy + (q >> 1), 0, 0, 'child', i);
        continue;
      }
      let found = false;
      for (let az = tz - 1, ax = tx >> 1, ay = ty >> 1; az >= minZoom; az--, ax >>= 1, ay >>= 1) {
        if (!ready(az, ax, ay)) continue;
        this.push(az, ax, ay, s.z - az, descendantCode(az, s.z, s.x, s.y), 'ancestor', i);
        found = true;
        break;
      }
      if (!found) this.holes++;
    }
    return this.out;
  }

  private push(z: number, x: number, y: number, depth: number, code: number, kind: DrawKind, node: number): void {
    const i = this.out.length;
    let it = this.pool[i];
    if (!it) { it = { z: 0, x: 0, y: 0, depth: 0, code: 0, kind: 'self', node: 0 }; this.pool[i] = it; }
    it.z = z; it.x = x; it.y = y; it.depth = depth; it.code = code; it.kind = kind; it.node = node;
    this.out.push(it);
  }
}

/**
 * Growable list of index ranges (start, count) for one tile's draw groups. `normalize()` sorts
 * by start and merges touching ranges, so neighbouring Morton quadrants become one draw call.
 */
export class RangeList {
  data = new Int32Array(32);
  /** number of (start, count) pairs */
  n = 0;

  clear(): void { this.n = 0; }

  add(start: number, count: number): void {
    if (2 * this.n + 2 > this.data.length) {
      const grown = new Int32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[2 * this.n] = start;
    this.data[2 * this.n + 1] = count;
    this.n++;
  }

  /** Sort by start (insertion sort: lists are short and nearly sorted) and merge touching or overlapping ranges. */
  normalize(): void {
    const d = this.data;
    for (let i = 1; i < this.n; i++) {
      const s = d[2 * i], c = d[2 * i + 1];
      let j = i - 1;
      while (j >= 0 && d[2 * j] > s) { d[2 * j + 2] = d[2 * j]; d[2 * j + 3] = d[2 * j + 1]; j--; }
      d[2 * j + 2] = s; d[2 * j + 3] = c;
    }
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const s = d[2 * i], e = s + d[2 * i + 1];
      if (w > 0 && s <= d[2 * w - 2] + d[2 * w - 1]) {
        const end = Math.max(d[2 * w - 2] + d[2 * w - 1], e);
        d[2 * w - 1] = end - d[2 * w - 2];
      } else { d[2 * w] = s; d[2 * w + 1] = e - s; w++; }
    }
    this.n = w;
  }
}
