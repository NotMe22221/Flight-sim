/**
 * Allocation-free bilinear table for the flight model's hot path. Same semantics as core
 * `Table2D` (clamped at the edges, row-major data), which builds a [index, fraction] tuple per
 * axis on every lookup — several hundred bytes of garbage per physics step when the JIT does not
 * inline it away.
 */
export class Grid2D {
  constructor(
    readonly rows: ArrayLike<number>,
    readonly cols: ArrayLike<number>,
    /** row-major, rows.length × cols.length */
    readonly data: ArrayLike<number>,
  ) {
    if (data.length !== rows.length * cols.length) throw new Error('Grid2D: bad sizes');
  }

  at(r: number, c: number): number {
    const rows = this.rows, cols = this.cols, nr = rows.length, nc = cols.length;
    let i = 0, ti = 0, j = 0, tj = 0;
    if (nr > 1 && r > rows[0]) {
      if (r >= rows[nr - 1]) i = nr - 1;
      else {
        let lo = 0, hi = nr - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (rows[mid] <= r) lo = mid; else hi = mid; }
        i = lo; ti = (r - rows[lo]) / (rows[hi] - rows[lo]);
      }
    }
    if (nc > 1 && c > cols[0]) {
      if (c >= cols[nc - 1]) j = nc - 1;
      else {
        let lo = 0, hi = nc - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cols[mid] <= c) lo = mid; else hi = mid; }
        j = lo; tj = (c - cols[lo]) / (cols[hi] - cols[lo]);
      }
    }
    const i1 = i + 1 < nr ? i + 1 : nr - 1, j1 = j + 1 < nc ? j + 1 : nc - 1;
    const d = this.data;
    const a = d[i * nc + j] + (d[i * nc + j1] - d[i * nc + j]) * tj;
    const b = d[i1 * nc + j] + (d[i1 * nc + j1] - d[i1 * nc + j]) * tj;
    return a + (b - a) * ti;
  }
}
