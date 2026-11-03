/**
 * Ground layers of a tile: buildings (rigid, base = lowest of five samples, collapsed until
 * grounded), draped surfaces (per vertex), light points (per point) and tree instances.
 */
import * as THREE from 'three';
import { GroundLayer, markRange, type GroundSampler, type TilePlacement, type UpdateRange } from './grounding';
import { BUILDING_SAMPLES, type BuildingsData, type DrapedData, type PointsData } from './protocol';

/** Re-ground a building only when its base moved by more than this (m). */
export const REGROUND_EPS_M = 0.05;

export class BuildingLayer extends GroundLayer {
  readonly ground: Float32Array;
  /** GPU position arrays (walls, plain, roofs) */
  readonly gpu: Float32Array[];
  /** base-relative template positions; released once every building is grounded */
  private template: Float32Array[] | null;
  readonly attrs: THREE.BufferAttribute[];
  private readonly ranges: Uint32Array;
  private readonly samples: Float32Array;
  private readonly sampleCount: Uint8Array;
  private readonly lo = [Infinity, Infinity, Infinity];
  private readonly hi = [-Infinity, -Infinity, -Infinity];
  /** tallest template y (m) for bounding volumes */
  readonly maxHeight: number;

  constructor(d: BuildingsData) {
    super(d.count, BUILDING_SAMPLES);
    this.ground = new Float32Array(d.count).fill(NaN);
    this.ranges = d.ranges;
    this.samples = d.samples;
    this.sampleCount = d.sampleCount;
    this.template = [d.walls.position, d.plain.position, d.roofs.position];
    this.gpu = this.template.map((t) => new Float32Array(t.length));
    this.attrs = this.gpu.map((g) => new THREE.BufferAttribute(g, 3));
    let maxH = 0;
    for (const t of this.template) for (let i = 1; i < t.length; i += 3) if (t[i] > maxH) maxH = t[i];
    this.maxHeight = maxH;
    for (let b = 0; b < d.count; b++) this.collapse(b);
  }

  /** All vertices of building b onto its first vertex (zero-area triangles: not drawn). */
  protected override costOf(b: number): number { return this.sampleCount[b] || BUILDING_SAMPLES; }

  private collapse(b: number): void {
    const t = this.template!;
    for (let m = 0; m < 3; m++) {
      const start = this.ranges[b * 6 + m * 2], count = this.ranges[b * 6 + m * 2 + 1];
      if (count === 0) continue;
      const src = t[m], dst = this.gpu[m];
      const x = src[start * 3], y = src[start * 3 + 1], z = src[start * 3 + 2];
      for (let v = start; v < start + count; v++) { dst[v * 3] = x; dst[v * 3 + 1] = y; dst[v * 3 + 2] = z; }
    }
  }

  protected sampleItem(b: number, s: GroundSampler, pl: TilePlacement): boolean {
    const prev = this.ground[b];
    const guess = Number.isFinite(prev) ? prev : this.meanGround;
    let g = Infinity;
    const n = this.sampleCount[b] || BUILDING_SAMPLES;
    for (let k = 0; k < n; k++) {
      const o = (b * BUILDING_SAMPLES + k) * 2;
      const y = s.sample(pl, this.samples[o], this.samples[o + 1], guess);
      if (Number.isNaN(y)) return Number.isFinite(prev);
      if (y < g) g = y;
    }
    this.noteGround(g);
    if (!Number.isFinite(prev)) this.place(b, g);
    else if (Math.abs(g - prev) > REGROUND_EPS_M) { this.noteMove(g - prev); this.shift(b, g - prev); }
    else return true;
    this.ground[b] = g;
    if (this.template && this.groundedCount + 1 >= this.n && !Number.isFinite(prev)) {
      // last building grounded on this sample: templates are no longer needed
      let all = true;
      for (let i = 0; i < this.n && all; i++) if (i !== b && !Number.isFinite(this.ground[i])) all = false;
      if (all) this.template = null;
    }
    return true;
  }

  private place(b: number, g: number): void {
    const t = this.template!;
    for (let m = 0; m < 3; m++) {
      const start = this.ranges[b * 6 + m * 2], count = this.ranges[b * 6 + m * 2 + 1];
      if (count === 0) continue;
      const src = t[m], dst = this.gpu[m];
      for (let v = start * 3, e = (start + count) * 3; v < e; v += 3) { dst[v] = src[v]; dst[v + 1] = src[v + 1] + g; dst[v + 2] = src[v + 2]; }
      this.mark(m, start, count);
    }
  }

  private shift(b: number, dy: number): void {
    for (let m = 0; m < 3; m++) {
      const start = this.ranges[b * 6 + m * 2], count = this.ranges[b * 6 + m * 2 + 1];
      if (count === 0) continue;
      const dst = this.gpu[m];
      for (let v = start * 3 + 1, e = (start + count) * 3; v < e; v += 3) dst[v] += dy;
      this.mark(m, start, count);
    }
  }

  private mark(m: number, start: number, count: number): void {
    if (start < this.lo[m]) this.lo[m] = start;
    if (start + count > this.hi[m]) this.hi[m] = start + count;
  }

  private readonly upd: UpdateRange[] = [{ start: 0, count: 0 }, { start: 0, count: 0 }, { start: 0, count: 0 }];

  flush(): void {
    for (let m = 0; m < 3; m++) {
      if (this.hi[m] <= this.lo[m]) continue;
      markRange(this.attrs[m], this.upd[m], this.lo[m] * 3, (this.hi[m] - this.lo[m]) * 3);
      this.lo[m] = Infinity; this.hi[m] = -Infinity;
    }
  }

  /** ground (tile-local y) of building b, NaN while it waits for terrain */
  groundOf(b: number): number { return this.ground[b]; }
}

/** Lifts at or below this (m) mark pavement next to a runway: no depth bias there. */
export const NO_BIAS_LIFT_M = 0.1;

/** Per-vertex draped surface: y = ground + lift. */
export class DrapeLayer extends GroundLayer {
  readonly attr: THREE.BufferAttribute;
  /** per-vertex depth-bias weight (1, or 0 next to runways) */
  readonly bias: THREE.BufferAttribute;
  private readonly pos: Float32Array;
  private readonly lift: Float32Array;
  private readonly g: Float32Array;

  constructor(d: DrapedData) {
    super(d.lift.length, 1);
    this.pos = d.mesh.position;
    this.lift = d.lift;
    this.g = new Float32Array(this.n).fill(NaN);
    this.attr = new THREE.BufferAttribute(this.pos, 3);
    const b = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) b[i] = this.lift[i] > NO_BIAS_LIFT_M ? 255 : 0;
    this.bias = new THREE.BufferAttribute(b, 1, true);
  }

  protected sampleItem(i: number, s: GroundSampler, pl: TilePlacement): boolean {
    const prev = this.g[i];
    const y = s.sample(pl, this.pos[i * 3], this.pos[i * 3 + 2], Number.isFinite(prev) ? prev : this.meanGround);
    if (Number.isNaN(y)) return Number.isFinite(prev);
    this.noteGround(y);
    if (Math.abs(y - prev) > 0.01 || !Number.isFinite(prev)) {
      if (Number.isFinite(prev)) this.noteMove(y - prev);
      this.g[i] = y;
      this.pos[i * 3 + 1] = y + this.lift[i];
      this.touch(i, i + 1);
    }
    return true;
  }

  protected override onFirstPass(): void {
    const m = this.meanGround;
    for (let i = 0; i < this.n; i++) if (!Number.isFinite(this.g[i])) this.pos[i * 3 + 1] = m + this.lift[i];
    this.touch(0, this.n);
  }

  private readonly upd: UpdateRange = { start: 0, count: 0 };

  flush(): void {
    if (this.dirtyHi <= this.dirtyLo) return;
    markRange(this.attr, this.upd, this.dirtyLo * 3, (this.dirtyHi - this.dirtyLo) * 3);
    this.resetDirty();
  }
}

/** Light points: y = ground + height. */
export class PointLayer extends GroundLayer {
  readonly attr: THREE.BufferAttribute;
  readonly color: THREE.BufferAttribute;
  private readonly pos: Float32Array;
  private readonly h: Float32Array;
  private readonly g: Float32Array;

  constructor(d: PointsData) {
    super(d.count, 1);
    this.pos = new Float32Array(d.count * 3);
    this.h = d.height;
    this.g = new Float32Array(d.count).fill(NaN);
    for (let i = 0; i < d.count; i++) { this.pos[i * 3] = d.xz[i * 2]; this.pos[i * 3 + 1] = d.height[i]; this.pos[i * 3 + 2] = d.xz[i * 2 + 1]; }
    this.attr = new THREE.BufferAttribute(this.pos, 3);
    this.color = new THREE.BufferAttribute(d.color, 3, true);
  }

  protected sampleItem(i: number, s: GroundSampler, pl: TilePlacement): boolean {
    const prev = this.g[i];
    const y = s.sample(pl, this.pos[i * 3], this.pos[i * 3 + 2], Number.isFinite(prev) ? prev : this.meanGround);
    if (Number.isNaN(y)) return Number.isFinite(prev);
    this.noteGround(y);
    if (Math.abs(y - prev) > 0.05 || !Number.isFinite(prev)) {
      if (Number.isFinite(prev)) this.noteMove(y - prev);
      this.g[i] = y;
      this.pos[i * 3 + 1] = y + this.h[i];
      this.touch(i, i + 1);
    }
    return true;
  }

  protected override onFirstPass(): void {
    const m = this.meanGround;
    for (let i = 0; i < this.n; i++) if (!Number.isFinite(this.g[i])) this.pos[i * 3 + 1] = m + this.h[i];
    this.touch(0, this.n);
  }

  private readonly upd: UpdateRange = { start: 0, count: 0 };

  flush(): void {
    if (this.dirtyHi <= this.dirtyLo) return;
    markRange(this.attr, this.upd, this.dirtyLo * 3, (this.dirtyHi - this.dirtyLo) * 3);
    this.resetDirty();
  }
}

/** Tree instances (x, z, height, rotation) → instance matrices; zero scale until grounded. */
export class TreeLayer extends GroundLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly src: Float32Array;
  private readonly g: Float32Array;
  private readonly m: Float32Array;

  constructor(src: Float32Array, colors: Uint8Array, geometry: THREE.BufferGeometry, material: THREE.Material) {
    const n = src.length / 4;
    super(n, 1);
    this.src = src;
    this.g = new Float32Array(n).fill(NaN);
    this.mesh = new THREE.InstancedMesh(geometry, material, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.m = this.mesh.instanceMatrix.array as Float32Array;
    this.m.fill(0);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) col[i] = colors[i] / 255;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
    this.mesh.matrixAutoUpdate = false;
  }

  protected sampleItem(i: number, s: GroundSampler, pl: TilePlacement): boolean {
    const prev = this.g[i];
    const o = i * 4;
    const y = s.sample(pl, this.src[o], this.src[o + 1], Number.isFinite(prev) ? prev : this.meanGround);
    if (Number.isNaN(y)) return Number.isFinite(prev);
    this.noteGround(y);
    if (Math.abs(y - prev) > 0.05 || !Number.isFinite(prev)) {
      if (Number.isFinite(prev)) this.noteMove(y - prev);
      this.g[i] = y;
      const h = this.src[o + 2], rot = this.src[o + 3];
      const c = Math.cos(rot), sn = Math.sin(rot);
      const w = h * (0.85 + 0.25 * ((i * 2654435761) % 1000) / 1000);
      const a = this.m, k = i * 16;
      a[k] = c * w; a[k + 1] = 0; a[k + 2] = -sn * w; a[k + 3] = 0;
      a[k + 4] = 0; a[k + 5] = h; a[k + 6] = 0; a[k + 7] = 0;
      a[k + 8] = sn * w; a[k + 9] = 0; a[k + 10] = c * w; a[k + 11] = 0;
      a[k + 12] = this.src[o]; a[k + 13] = y - 0.3; a[k + 14] = this.src[o + 1]; a[k + 15] = 1;
      this.touch(i, i + 1);
    }
    return true;
  }

  private readonly upd: UpdateRange = { start: 0, count: 0 };

  flush(): void {
    if (this.dirtyHi <= this.dirtyLo) return;
    markRange(this.mesh.instanceMatrix, this.upd, this.dirtyLo * 16, (this.dirtyHi - this.dirtyLo) * 16);
    this.resetDirty();
  }
}
