/**
 * Placement of tile-local geometry in the current LocalFrame and time-sliced ground sampling.
 *
 * A tile group is a rigid object: position = the tile centre through `frame.ecefToThree`,
 * orientation = the rotation between the tile's tangent frame and the current one (meridian
 * convergence + tangent-plane tilt). Ground heights come from `groundUp(north, east)` of the
 * current frame and are converted back into tile-local y along the tile's own vertical, with
 * one fixed-point step from the previous estimate (exact as heights refine).
 *
 * Ground layers hold items (buildings, draped vertices, light points, trees). Each `step`
 * spends a sample budget: a first pass over all items, then endless gradual re-sampling so
 * nothing floats or sinks as finer terrain arrives.
 */
import type { LocalFrame } from '../geo/wgs84';

export type GroundUpFn = (north: number, east: number) => number | null;

export interface UpdateRange { start: number; count: number }

/**
 * Mark [start, start + count) of an attribute for upload without allocating: one persistent
 * range object per attribute, widened while an earlier range is still waiting for upload
 * (three clears `updateRanges` after each upload).
 */
export function markRange(a: { updateRanges: UpdateRange[]; needsUpdate: boolean }, r: UpdateRange, start: number, count: number): void {
  const ur = a.updateRanges;
  if (ur.length === 1 && ur[0] === r) {
    const end = Math.max(r.start + r.count, start + count);
    r.start = Math.min(r.start, start);
    r.count = end - r.start;
  } else {
    if (ur.length > 0) {
      // ranges from elsewhere: fold them in so nothing pending is lost
      let lo = start, hi = start + count;
      for (let i = 0; i < ur.length; i++) { lo = Math.min(lo, ur[i].start); hi = Math.max(hi, ur[i].start + ur[i].count); }
      start = lo; count = hi - lo;
    }
    r.start = start; r.count = count;
    ur.length = 0;
    ur.push(r);
  }
  a.needsUpdate = true;
}

export class TilePlacement {
  tx = 0; ty = 0; tz = 0;
  /** row-major 3×3 rotation tile-local (E, U, S) → frame (E, U, S) */
  readonly r = new Float64Array(9);
  private readonly p: [number, number, number] = [0, 0, 0];

  set(tileFrame: LocalFrame, frame: LocalFrame): void {
    frame.ecefToThree(tileFrame.origin, this.p);
    this.tx = this.p[0]; this.ty = this.p[1]; this.tz = this.p[2];
    const fe = tileFrame.east, fu = tileFrame.up, fn = tileFrame.north;
    const te = frame.east, tu = frame.up, tn = frame.north;
    const d = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const r = this.r;
    r[0] = d(te, fe); r[1] = d(te, fu); r[2] = -d(te, fn);
    r[3] = d(tu, fe); r[4] = d(tu, fu); r[5] = -d(tu, fn);
    r[6] = -d(tn, fe); r[7] = -d(tn, fu); r[8] = d(tn, fn);
  }

  /** Column-major 4×4 for Object3D.matrix. */
  toMatrixArray(out: number[] | Float32Array | Float64Array): void {
    const r = this.r;
    out[0] = r[0]; out[1] = r[3]; out[2] = r[6]; out[3] = 0;
    out[4] = r[1]; out[5] = r[4]; out[6] = r[7]; out[7] = 0;
    out[8] = r[2]; out[9] = r[5]; out[10] = r[8]; out[11] = 0;
    out[12] = this.tx; out[13] = this.ty; out[14] = this.tz; out[15] = 1;
  }

  /** Local point → render frame (x, y, z). */
  toWorld(x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
    const r = this.r;
    out.x = this.tx + r[0] * x + r[1] * y + r[2] * z;
    out.y = this.ty + r[3] * x + r[4] * y + r[5] * z;
    out.z = this.tz + r[6] * x + r[7] * y + r[8] * z;
  }
}

/** Shared sampling context (one per manager); counts calls for the budget. */
export class GroundSampler {
  groundUp: GroundUpFn;
  calls = 0;
  constructor(groundUp: GroundUpFn) { this.groundUp = groundUp; }

  /** Tile-local ground y under local (x, z), starting from the estimate `guess`; NaN when unknown. */
  sample(pl: TilePlacement, x: number, z: number, guess: number): number {
    const r = pl.r;
    const g = Number.isFinite(guess) ? guess : 0;
    this.calls++;
    const wx = pl.tx + r[0] * x + r[1] * g + r[2] * z;
    const wz = pl.tz + r[6] * x + r[7] * g + r[8] * z;
    const u = this.groundUp(-wz, wx);
    if (u === null || !Number.isFinite(u)) return NaN;
    return (u - pl.ty - r[3] * x - r[5] * z) / r[4];
  }
}

/** Base of every ground layer: item cursor, first-pass bookkeeping and ground statistics. */
export abstract class GroundLayer {
  readonly n: number;
  readonly grounded: Uint8Array;
  groundedCount = 0;
  cursor = 0;
  /** completed passes over all items (counted once something is grounded) */
  passes = 0;
  /** times the cursor wrapped, grounded or not (pass ends for round-robin bookkeeping) */
  wraps = 0;
  minG = Infinity;
  maxG = -Infinity;
  private sumG = 0;
  private sumN = 0;
  /** vertex / item range touched since the last flush */
  protected dirtyLo = Infinity;
  protected dirtyHi = -Infinity;
  /** samples one item costs */
  readonly cost: number;

  constructor(n: number, cost: number) {
    this.n = n;
    this.cost = cost;
    this.grounded = new Uint8Array(n);
  }

  get firstPassDone(): boolean { return this.passes > 0; }
  get complete(): boolean { return this.groundedCount === this.n; }
  /** mean ground of the grounded items (0 before any) */
  get meanGround(): number { return this.sumN > 0 ? this.sumG / this.sumN : 0; }

  protected noteGround(g: number): void {
    if (g < this.minG) this.minG = g;
    if (g > this.maxG) this.maxG = g;
    // running mean of recent values (bounded weight so it follows refinements)
    if (this.sumN < 256) { this.sumG += g; this.sumN++; } else this.sumG += g - this.sumG / this.sumN;
  }

  protected touch(lo: number, hi: number): void {
    if (lo < this.dirtyLo) this.dirtyLo = lo;
    if (hi > this.dirtyHi) this.dirtyHi = hi;
  }

  /** Sample item i; true when it got a ground height. */
  protected abstract sampleItem(i: number, s: GroundSampler, pl: TilePlacement): boolean;
  /** Samples item i costs (default: the layer's fixed cost). */
  protected costOf(_i: number): number { return this.cost; }
  /** Upload the dirty range. */
  abstract flush(): void;

  /**
   * Spend up to `budget` samples; returns samples used. With `untilPassEnd` it also stops when
   * the cursor wraps (end of a pass), so a caller can hand the rest of its budget to other layers.
   */
  step(budget: number, s: GroundSampler, pl: TilePlacement, untilPassEnd = false): number {
    if (this.n === 0) { if (this.passes === 0) this.passes = 1; return 0; }
    let used = 0;
    while (used < budget) {
      const i = this.cursor;
      const c = this.costOf(i);
      if (used > 0 && used + c > budget) break;
      if (this.sampleItem(i, s, pl) && !this.grounded[i]) { this.grounded[i] = 1; this.groundedCount++; }
      used += c;
      if (++this.cursor >= this.n) {
        this.cursor = 0;
        this.wraps++;
        if (this.groundedCount > 0) {
          if (this.passes === 0) this.onFirstPass();
          this.passes++;
        }
        if (untilPassEnd) break;
      }
    }
    return used;
  }

  /** Called once when the first full pass ends (fill missing items from the mean). */
  protected onFirstPass(): void { /* optional */ }

  protected resetDirty(): void { this.dirtyLo = Infinity; this.dirtyHi = -Infinity; }
}
