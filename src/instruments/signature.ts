/**
 * Cheap change detection for canvas displays: values are quantised to their display resolution
 * and folded into a 32-bit FNV-1a hash. When the hash of what a display would show equals the
 * previous one, the redraw and the texture upload can be skipped (docs/research/05 §3.2: "skip
 * the upload if nothing changed — compare a hash of the quantised readings"). Owners still force
 * a periodic redraw so a hash collision can never freeze a display for long.
 */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export class Signature {
  private h = FNV_OFFSET;

  /** Start a new hash. */
  reset(): this { this.h = FNV_OFFSET; return this; }

  /** Fold in `v` quantised to `quantum` (non-finite values share one token). */
  num(v: number, quantum = 1): this {
    if (!Number.isFinite(v)) { this.mix(0x7ff00001); return this; }
    const q = Math.round(v / quantum);
    this.mix(q | 0);
    this.mix((q / 4294967296) | 0);
    return this;
  }

  bool(b: boolean): this { this.mix(b ? 0x51 : 0x52); return this; }

  /** Fold in a string (idents, mode names); null/undefined hash as a distinct token. */
  str(s: string | null | undefined): this {
    if (s === null || s === undefined) { this.mix(0x7ff00002); return this; }
    for (let i = 0; i < s.length; i++) this.mix(s.charCodeAt(i));
    this.mix(s.length);
    return this;
  }

  /** The current 32-bit hash. */
  get value(): number { return this.h; }

  private mix(x: number): void { this.h = Math.imul(this.h ^ x, FNV_PRIME) >>> 0; }
}
