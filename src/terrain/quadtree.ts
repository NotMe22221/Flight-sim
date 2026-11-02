/**
 * CDLOD node selection over the Web-Mercator tile quadtree (docs/research/03 §3.2).
 *
 * Level 0 is the finest zoom (15), level L−1 the coarsest (7). A node at level l is drawn
 * when its AABB is within `range[l] = range0·2^l` of the camera and not within
 * `range[l−1]` (otherwise its children take over). Children that fall outside their own
 * range are drawn as *parent patches*: the parent's mesh restricted to that quadrant.
 * Per-node hysteresis (split at r, merge at (1+h)·r) stops flapping at range boundaries.
 *
 * No Three.js: the frustum is any object with `intersectsBox(min, max)`, positions are
 * Three.js-frame arrays (x East, y Up, z South), AABBs come from a height-range callback.
 */
import type { Geodetic, Vec3 } from '../core/types';
import { MAX_LAT, lonLatToTile, tileToLonLat, tileWidthMeters } from '../geo/mercator';
import { EARTH_RADIUS, LocalFrame } from '../geo/wgs84';

export interface FrustumLike {
  intersectsBox(min: ArrayLike<number>, max: ArrayLike<number>): boolean;
}

/** Height range source: writes [minH, maxH] to out and returns the zoom it came from, or -1. */
export type HeightRangeFn = (z: number, x: number, y: number, out: Float64Array) => number;

export interface QuadtreeOptions {
  /** finest zoom (level 0) */
  finestZoom: number;
  /** coarsest zoom (root level) */
  coarsestZoom: number;
  /** level-0 range in metres (3.5 km desktop ≈ 2 px SSE at 1080p; 1.8 km low-end) */
  range0: number;
  /** merge at (1 + hysteresis) × range */
  hysteresis: number;
  /** height bounds assumed for tiles whose data is not loaded yet */
  defaultMinH: number;
  defaultMaxH: number;
  /** skip nodes entirely hidden below the horizon by earth curvature */
  horizonCull: boolean;
}

export const DEFAULT_QUADTREE_OPTIONS: QuadtreeOptions = {
  finestZoom: 15,
  coarsestZoom: 7,
  range0: 3500,
  hysteresis: 0.15,
  defaultMinH: -500,
  defaultMaxH: 9000,
  horizonCull: false,
};

export interface SelectedNode {
  z: number;
  x: number;
  y: number;
  key: string;
  /** level index (0 = finest) of the *area* this entry covers */
  level: number;
  /** true → draw the parent's mesh restricted to this quadrant */
  parentPatch: boolean;
  /** distance from the camera to the node's AABB, m */
  distance: number;
}

interface Node {
  z: number; x: number; y: number; key: string;
  min: Float64Array; max: Float64Array;
  /** frame epoch the AABB was computed for */
  epoch: number;
  /** zoom of the tile that supplied the height range (-1 = defaults) */
  hSource: number;
  /** max height used for the AABB (horizon test) */
  maxH: number;
  /** hysteresis state */
  active: boolean;
  split: boolean;
  /** last selection pass that visited this node */
  visit: number;
}

const D2R = Math.PI / 180;

export class Quadtree {
  readonly options: QuadtreeOptions;
  /** range[l] in metres */
  readonly ranges: Float64Array;
  readonly levels: number;
  private frame: LocalFrame;
  private epoch = 0;
  private pass = 0;
  private readonly nodes = new Map<string, Node>();
  private readonly pool: SelectedNode[] = [];
  private readonly hRange = new Float64Array(2);
  private readonly camGeo: Geodetic = { lat: 0, lon: 0, alt: 0 };
  private readonly cam = new Float64Array(3);
  private readonly tmp = new Float64Array(3);
  private frustum: FrustumLike | null = null;
  private out: SelectedNode[] = [];
  private heightRange: HeightRangeFn;

  constructor(frame: LocalFrame, options: Partial<QuadtreeOptions> = {}, heightRange: HeightRangeFn = () => -1) {
    this.options = { ...DEFAULT_QUADTREE_OPTIONS, ...options };
    const o = this.options;
    if (o.finestZoom < o.coarsestZoom) throw new Error('Quadtree: finestZoom must be ≥ coarsestZoom');
    this.levels = o.finestZoom - o.coarsestZoom + 1;
    this.ranges = new Float64Array(this.levels);
    for (let l = 0; l < this.levels; l++) this.ranges[l] = o.range0 * 2 ** l;
    this.frame = frame;
    this.heightRange = heightRange;
  }

  /** Replace the height-range source (e.g. after providers change). */
  setHeightRange(fn: HeightRangeFn): void { this.heightRange = fn; this.epoch++; }

  /** Floating-origin rebase: all cached AABBs are recomputed lazily in the new frame. */
  setFrame(frame: LocalFrame): void { this.frame = frame; this.epoch++; }

  /** Zoom of level l. */
  zoomOf(level: number): number { return this.options.finestZoom - level; }
  /** Level of zoom z. */
  levelOf(z: number): number { return this.options.finestZoom - z; }

  /** Number of cached nodes (diagnostics). */
  get nodeCount(): number { return this.nodes.size; }

  /**
   * Select the nodes to draw for a camera at `cameraPos` (Three.js frame coords). `frustum`
   * may be null (no culling). The returned array (and its records) are reused on the next
   * call — copy anything you keep.
   */
  select(cameraPos: ArrayLike<number>, frustum: FrustumLike | null): readonly SelectedNode[] {
    this.pass++;
    this.frustum = frustum;
    this.out.length = 0;
    const cam = this.cam;
    cam[0] = cameraPos[0]; cam[1] = cameraPos[1]; cam[2] = cameraPos[2];
    const o = this.options, L = this.levels, zc = o.coarsestZoom;
    const geo = this.frame.threeToGeodetic(cam[0], cam[1], cam[2], this.camGeo);
    const n = 2 ** zc;
    const t = lonLatToTile(geo.lon, Math.max(-MAX_LAT, Math.min(MAX_LAT, geo.lat)), zc);
    const cx = Math.floor(t.x), cy = Math.floor(t.y);
    const k = Math.ceil(this.ranges[L - 1] / tileWidthMeters(geo.lat, zc)) + 1;
    for (let dy = -k; dy <= k; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= n) continue;
      for (let dx = -k; dx <= k; dx++) {
        let x = (cx + dx) % n;
        if (x < 0) x += n;
        this.selectNode(this.node(zc, x, y), L - 1);
      }
    }
    if ((this.pass & 255) === 0) this.prune();
    return this.out;
  }

  private node(z: number, x: number, y: number): Node {
    const key = `${z}/${x}/${y}`;
    let nd = this.nodes.get(key);
    if (!nd) {
      nd = { z, x, y, key, min: new Float64Array(3), max: new Float64Array(3), epoch: -1, hSource: -2, maxH: 0, active: false, split: false, visit: 0 };
      this.nodes.set(key, nd);
    }
    nd.visit = this.pass;
    return nd;
  }

  /** Drop nodes not visited for a while so the cache does not grow without bound. */
  private prune(): void {
    for (const [key, nd] of this.nodes) if (this.pass - nd.visit > 512) this.nodes.delete(key);
  }

  private updateAabb(nd: Node): void {
    const hr = this.hRange;
    let src = nd.hSource;
    if (src !== nd.z) { // a tile's own data is final; otherwise look for better ancestors each pass
      src = this.heightRange(nd.z, nd.x, nd.y, hr);
      if (src === nd.hSource && nd.epoch === this.epoch) return;
    } else if (nd.epoch === this.epoch) return;
    else this.heightRange(nd.z, nd.x, nd.y, hr);
    const minH = src < 0 ? this.options.defaultMinH : hr[0];
    const maxH = src < 0 ? this.options.defaultMaxH : hr[1];
    nd.hSource = src;
    nd.maxH = maxH;
    nd.epoch = this.epoch;
    computeTileAabb(this.frame, nd.z, nd.x, nd.y, minH, maxH, nd.min, nd.max, this.tmp);
  }

  private distSq(nd: Node): number {
    const c = this.cam;
    let d = 0;
    for (let i = 0; i < 3; i++) {
      const v = c[i] < nd.min[i] ? nd.min[i] - c[i] : c[i] > nd.max[i] ? c[i] - nd.max[i] : 0;
      d += v * v;
    }
    return d;
  }

  /** True when every point of the box is hidden below the camera's horizon (conservative). */
  private belowHorizon(nd: Node): boolean {
    const camAlt = this.camGeo.alt;
    const dCam = Math.sqrt(2 * EARTH_RADIUS * Math.max(camAlt, 0));
    // highest point of the tile above the ellipsoid ≈ max height stored in the AABB source
    const hTop = Math.max(nd.maxH, 0);
    const dTop = Math.sqrt(2 * EARTH_RADIUS * hTop);
    const c = this.cam;
    const ex = c[0] < nd.min[0] ? nd.min[0] - c[0] : c[0] > nd.max[0] ? c[0] - nd.max[0] : 0;
    const ez = c[2] < nd.min[2] ? nd.min[2] - c[2] : c[2] > nd.max[2] ? c[2] - nd.max[2] : 0;
    const horizontal = Math.hypot(ex, ez);
    return horizontal > dCam + dTop + 2000;
  }

  private push(nd: Node, level: number, parentPatch: boolean, d2: number): void {
    const i = this.out.length;
    let rec = this.pool[i];
    if (!rec) { rec = { z: 0, x: 0, y: 0, key: '', level: 0, parentPatch: false, distance: 0 }; this.pool[i] = rec; }
    rec.z = nd.z; rec.x = nd.x; rec.y = nd.y; rec.key = nd.key; rec.level = level; rec.parentPatch = parentPatch; rec.distance = Math.sqrt(d2);
    this.out.push(rec);
  }

  /** Returns true when the node's area is handled (drawn, culled or split), false when the parent must cover it. */
  private selectNode(nd: Node, level: number): boolean {
    this.updateAabb(nd);
    const h = 1 + this.options.hysteresis;
    const d2 = this.distSq(nd);
    const r = this.ranges[level] * (nd.active ? h : 1);
    if (d2 > r * r) { nd.active = false; nd.split = false; return false; }
    nd.active = true;
    if (this.frustum && !this.frustum.intersectsBox(nd.min, nd.max)) return true;
    if (this.options.horizonCull && this.belowHorizon(nd)) return true;
    if (level === 0) { this.push(nd, 0, false, d2); return true; }
    const rs = this.ranges[level - 1] * (nd.split ? h : 1);
    if (d2 > rs * rs) { nd.split = false; this.push(nd, level, false, d2); return true; }
    nd.split = true;
    const z = nd.z + 1, x0 = nd.x * 2, y0 = nd.y * 2;
    // Children handled by themselves vs. covered by this node's mesh (parent patch).
    const mark = this.out.length;
    let covered = 0;
    for (let q = 0; q < 4; q++) {
      const child = this.node(z, x0 + (q & 1), y0 + (q >> 1));
      if (!this.selectNode(child, level - 1)) { this.push(child, level - 1, true, this.distSq(child)); covered++; }
    }
    if (covered === 4) { // nothing finer was drawn: one whole draw beats four quadrant draws
      this.out.length = mark;
      this.push(nd, level, false, d2);
    }
    return true;
  }
}

/**
 * Frame-space AABB of tile (z, x, y) for heights in [minH, maxH]: the 4 corners and the centre
 * at both heights, padded by the curvature sag `a²/R` (a = half width) so the bulging
 * surface and the convergence of meridians are contained.
 */
export function computeTileAabb(
  frame: LocalFrame, z: number, x: number, y: number, minH: number, maxH: number,
  min: Float64Array | Vec3, max: Float64Array | Vec3, tmp: Float64Array = new Float64Array(3),
): void {
  min[0] = min[1] = min[2] = Infinity;
  max[0] = max[1] = max[2] = -Infinity;
  const nw = tileToLonLat(x, y, z), se = tileToLonLat(x + 1, y + 1, z), c = tileToLonLat(x + 0.5, y + 0.5, z);
  const lons = [nw.lon, se.lon, nw.lon, se.lon, c.lon], lats = [nw.lat, nw.lat, se.lat, se.lat, c.lat];
  for (let i = 0; i < 5; i++) {
    const la = lats[i] * D2R, lo = lons[i] * D2R;
    const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
    const Nr = 6378137 / Math.sqrt(1 - 6.69437999014e-3 * sl * sl);
    // point at h = 0 and the geodetic up vector, both in ECEF
    const px = Nr * cl * co, py = Nr * cl * so, pz = Nr * (1 - 6.69437999014e-3) * sl;
    const ux = cl * co, uy = cl * so, uz = sl;
    for (let k = 0; k < 2; k++) {
      const hh = k === 0 ? minH : maxH;
      tmp[0] = px + ux * hh; tmp[1] = py + uy * hh; tmp[2] = pz + uz * hh;
      frame.ecefToThree(tmp as unknown as Vec3, tmp as unknown as Vec3);
      for (let a = 0; a < 3; a++) { if (tmp[a] < min[a]) min[a] = tmp[a]; if (tmp[a] > max[a]) max[a] = tmp[a]; }
    }
  }
  const half = 0.5 * tileWidthMeters(c.lat, z);
  const pad = (half * half) / EARTH_RADIUS + 1;
  for (let a = 0; a < 3; a++) { min[a] -= pad; max[a] += pad; }
}
