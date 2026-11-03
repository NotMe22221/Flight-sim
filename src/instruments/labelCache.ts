/**
 * Memoised number → string formatting for readouts redrawn every frame. Canvas text needs a
 * string, and building "285°" or "12.4" with template literals at 30 Hz churns the GC; a bounded
 * map keyed by the quantised value returns the same string instance while the value is steady.
 */

/** Caches `format(v)` per quantised key. Keys are `Math.round(value / quantum)`. */
export class LabelCache {
  private readonly map = new Map<number, string>();

  /**
   * @param format  builds the label from the quantised value (called only on a cache miss)
   * @param quantum value resolution; 1 for integers, 0.1 for one decimal
   * @param maxSize the cache is cleared when it grows beyond this many entries
   */
  constructor(private readonly format: (value: number) => string, private readonly quantum = 1, private readonly maxSize = 1024) {}

  /** Label for `value` (NaN/±Infinity share one key and are formatted as NaN). */
  get(value: number): string {
    const key = Number.isFinite(value) ? Math.round(value / this.quantum) : Number.NaN;
    const mapKey = Number.isNaN(key) ? -0x7fffffff : key;
    let s = this.map.get(mapKey);
    if (s === undefined) {
      if (this.map.size >= this.maxSize) this.map.clear();
      s = this.format(Number.isNaN(key) ? Number.NaN : key * this.quantum);
      this.map.set(mapKey, s);
    }
    return s;
  }
}
