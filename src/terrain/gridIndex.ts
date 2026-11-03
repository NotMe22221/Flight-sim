/**
 * Shared index buffers for the N×N-quad tile grid plus its skirt ring.
 *
 * Grid triangles are emitted in Morton (Z-order) of the quads so that any aligned
 * sub-square (a quadrant, a quadrant of a quadrant, …) is a contiguous index range. That is
 * what lets a parent tile be drawn restricted to one child's area (CDLOD "parent patch" or
 * the nearest-loaded-ancestor fallback) with a plain draw range.
 *
 * Vertex layout (shared with tileMesh.ts): main grid vertex (i, j) → `j * (N+1) + i`,
 * i east (+x), j south (+z). Skirt vertices follow at `S = (N+1)²`: top edge (j = 0,
 * i = 0..N), bottom (j = N), left (i = 0, j = 0..N), right (i = N), then the two midlines
 * (vertical i = N/2, j = 0..N; horizontal j = N/2, i = 0..N), each N+1 vertices.
 *
 * Index layout: grid (6·N² indices, Morton order), then the four edge skirts, each a run of
 * N quads (6·N indices) in edge order: top, bottom, left, right — `tileIndexCount` ends here
 * and is what a whole tile draws. After that come four midline skirt runs (N quads each):
 * vertical midline facing east, facing west, horizontal midline facing south, facing north.
 * A sub-square draws the skirt segments on its own border — tile edges and midlines — so a
 * CDLOD parent patch (one quadrant of the parent mesh) has skirts on all four sides and no
 * crack opens where the coarser parent surface lies above its finer neighbour's edge.
 */

const cache = new Map<number, Uint16Array | Uint32Array>();

/** Interleave the low 16 bits of x (even bits) and y (odd bits). */
export function mortonEncode(x: number, y: number): number {
  return spread(x) | (spread(y) << 1);
}
function spread(v: number): number {
  v &= 0xffff;
  v = (v | (v << 8)) & 0x00ff00ff;
  v = (v | (v << 4)) & 0x0f0f0f0f;
  v = (v | (v << 2)) & 0x33333333;
  v = (v | (v << 1)) & 0x55555555;
  return v;
}
function compact(v: number): number {
  v &= 0x55555555;
  v = (v | (v >>> 1)) & 0x33333333;
  v = (v | (v >>> 2)) & 0x0f0f0f0f;
  v = (v | (v >>> 4)) & 0x00ff00ff;
  v = (v | (v >>> 8)) & 0x0000ffff;
  return v;
}
/** Inverse of mortonEncode; writes x to out[0], y to out[1]. */
export function mortonDecode(code: number, out: Int32Array | number[]): void {
  out[0] = compact(code);
  out[1] = compact(code >>> 1);
}

/** Number of vertices in a tile mesh with `quads` quads per side (grid + edge and midline skirts). */
export const tileVertexCount = (quads: number): number => (quads + 1) * (quads + 1) + 6 * (quads + 1);
/** Number of vertices of the main grid only. */
export const gridVertexCount = (quads: number): number => (quads + 1) * (quads + 1);
/** Number of indices of the main grid (6 per quad). */
export const gridIndexCount = (quads: number): number => 6 * quads * quads;
/** Index count of a whole tile: grid + the four edge skirts (4·N skirt quads). */
export const tileIndexCount = (quads: number): number => 6 * (quads * quads + 4 * quads);
/** Length of the shared index buffer: whole tile + the four midline skirt runs (4·N quads). */
export const fullIndexCount = (quads: number): number => 6 * (quads * quads + 8 * quads);

function assertPow2(quads: number): void {
  if (quads < 2 || (quads & (quads - 1)) !== 0) throw new Error(`gridIndex: quads must be a power of two ≥ 2, got ${quads}`);
}

/**
 * Index buffer for a `quads`×`quads` grid with skirts. Cached per `quads` and shared by every
 * tile (one GPU upload). Uint16 when the vertex count allows it.
 */
export function gridIndex(quads: number): Uint16Array | Uint32Array {
  assertPow2(quads);
  const cached = cache.get(quads);
  if (cached) return cached;
  const N = quads, W = N + 1;
  const count = fullIndexCount(N);
  const index = tileVertexCount(N) <= 65535 ? new Uint16Array(count) : new Uint32Array(count);
  const xy = new Int32Array(2);
  let k = 0;
  for (let m = 0; m < N * N; m++) {
    mortonDecode(m, xy);
    const i = xy[0], j = xy[1];
    const v0 = j * W + i, v1 = v0 + 1, v2 = v0 + W, v3 = v2 + 1;
    // CCW seen from above (+y): NW → SW → NE, NE → SW → SE
    index[k++] = v0; index[k++] = v2; index[k++] = v1;
    index[k++] = v1; index[k++] = v2; index[k++] = v3;
  }
  // Skirts. Edge vertex a → b along the edge, a' / b' the dropped copies. Winding chosen so the
  // wall's front face points away from the tile (see tileMesh.test.ts for the geometric check).
  const S = W * W;
  const top = S, bottom = S + W, left = S + 2 * W, right = S + 3 * W;
  for (let i = 0; i < N; i++) {
    // top edge (north, j = 0): outward −z
    const a = i, b = i + 1, as = top + i, bs = top + i + 1;
    index[k++] = a; index[k++] = b; index[k++] = bs;
    index[k++] = a; index[k++] = bs; index[k++] = as;
  }
  for (let i = 0; i < N; i++) {
    // bottom edge (south, j = N): outward +z → reversed winding
    const a = N * W + i, b = a + 1, as = bottom + i, bs = bottom + i + 1;
    index[k++] = a; index[k++] = bs; index[k++] = b;
    index[k++] = a; index[k++] = as; index[k++] = bs;
  }
  for (let j = 0; j < N; j++) {
    // left edge (west, i = 0): outward −x → reversed winding
    const a = j * W, b = a + W, as = left + j, bs = left + j + 1;
    index[k++] = a; index[k++] = bs; index[k++] = b;
    index[k++] = a; index[k++] = as; index[k++] = bs;
  }
  for (let j = 0; j < N; j++) {
    // right edge (east, i = N): outward +x
    const a = j * W + N, b = a + W, as = right + j, bs = right + j + 1;
    index[k++] = a; index[k++] = b; index[k++] = bs;
    index[k++] = a; index[k++] = bs; index[k++] = as;
  }
  // Midline skirts, both facings (used by the sub-squares on either side of each line).
  const half = N >> 1, vmid = S + 4 * W, hmid = S + 5 * W;
  for (let j = 0; j < N; j++) {
    // vertical midline (i = N/2) facing east (+x): border of the western sub-squares
    const a = j * W + half, b = a + W, as = vmid + j, bs = vmid + j + 1;
    index[k++] = a; index[k++] = b; index[k++] = bs;
    index[k++] = a; index[k++] = bs; index[k++] = as;
  }
  for (let j = 0; j < N; j++) {
    // vertical midline facing west (−x): border of the eastern sub-squares
    const a = j * W + half, b = a + W, as = vmid + j, bs = vmid + j + 1;
    index[k++] = a; index[k++] = bs; index[k++] = b;
    index[k++] = a; index[k++] = as; index[k++] = bs;
  }
  for (let i = 0; i < N; i++) {
    // horizontal midline (j = N/2) facing south (+z): border of the northern sub-squares
    const a = half * W + i, b = a + 1, as = hmid + i, bs = hmid + i + 1;
    index[k++] = a; index[k++] = bs; index[k++] = b;
    index[k++] = a; index[k++] = as; index[k++] = bs;
  }
  for (let i = 0; i < N; i++) {
    // horizontal midline facing north (−z): border of the southern sub-squares
    const a = half * W + i, b = a + 1, as = hmid + i, bs = hmid + i + 1;
    index[k++] = a; index[k++] = b; index[k++] = bs;
    index[k++] = a; index[k++] = bs; index[k++] = as;
  }
  cache.set(quads, index);
  return index;
}

export interface IndexRange { start: number; count: number }

/** Clamp a (depth, code) sub-square path to the grid's resolution (a single quad at most). */
function clampDepth(quads: number, depth: number, code: number): { depth: number; code: number } {
  const maxDepth = Math.log2(quads);
  if (depth > maxDepth) return { depth: maxDepth, code: code >>> (2 * (depth - maxDepth)) };
  return { depth, code };
}

/**
 * Index range (into `gridIndex(quads)`) of the grid sub-square at `depth` levels below the
 * tile whose Morton path is `code` (bit pairs, most significant pair = first subdivision;
 * each pair = (y & 1) << 1 | (x & 1), i.e. 0 NW, 1 NE, 2 SW, 3 SE). `depth` is clamped to
 * log2(quads) (a single quad).
 */
export function quadrantGridRange(quads: number, depth: number, code: number): IndexRange {
  assertPow2(quads);
  const c = clampDepth(quads, depth, code);
  const quadsPerSide = quads >>> c.depth;
  const quadCount = quadsPerSide * quadsPerSide;
  return { start: c.code * quadCount * 6, count: quadCount * 6 };
}

/**
 * Skirt index ranges for the border of the sub-square described by (depth, code): the
 * segments of the tile's edge skirts and midline skirts that lie on it. Borders on other
 * interior lines have no skirt. Returns up to 4 ranges (a quadrant: two edge, two midline).
 */
export function quadrantSkirtRanges(quads: number, depth: number, code: number, out: IndexRange[] = []): IndexRange[] {
  assertPow2(quads);
  out.length = 0;
  const c = clampDepth(quads, depth, code);
  const N = quads;
  const side = N >>> c.depth; // quads per side of the sub-square
  // Sub-square origin in quad units: decode the path from the most significant pair down.
  let i0 = 0, j0 = 0;
  for (let d = 0; d < c.depth; d++) {
    const pair = (c.code >>> (2 * (c.depth - 1 - d))) & 3;
    const half = N >>> (d + 1);
    if (pair & 1) i0 += half;
    if (pair & 2) j0 += half;
  }
  const gridEnd = gridIndexCount(N);
  const top = gridEnd, bottom = gridEnd + 6 * N, left = gridEnd + 12 * N, right = gridEnd + 18 * N;
  if (j0 === 0) out.push({ start: top + i0 * 6, count: side * 6 });
  if (j0 + side === N) out.push({ start: bottom + i0 * 6, count: side * 6 });
  if (i0 === 0) out.push({ start: left + j0 * 6, count: side * 6 });
  if (i0 + side === N) out.push({ start: right + j0 * 6, count: side * 6 });
  if (c.depth > 0) {
    const half = N >>> 1, mid = gridEnd + 24 * N;
    if (i0 + side === half) out.push({ start: mid + j0 * 6, count: side * 6 });          // east border on the vertical midline
    if (i0 === half) out.push({ start: mid + 6 * N + j0 * 6, count: side * 6 });         // west border on it
    if (j0 + side === half) out.push({ start: mid + 12 * N + i0 * 6, count: side * 6 }); // south border on the horizontal midline
    if (j0 === half) out.push({ start: mid + 18 * N + i0 * 6, count: side * 6 });        // north border on it
  }
  return out;
}

/**
 * Morton path code of the descendant tile (zc, xc, yc) relative to its ancestor at zoom
 * `za` (depth = zc − za): the bit pairs of the child's x/y below the ancestor, most
 * significant first — the `code` argument of `quadrantGridRange`/`quadrantSkirtRanges`.
 */
export function descendantCode(za: number, zc: number, xc: number, yc: number): number {
  const depth = zc - za;
  const mask = (1 << depth) - 1;
  return mortonEncode(xc & mask, yc & mask);
}

/**
 * Allocation-free form of `quadrantGridRange` + `quadrantSkirtRanges`: writes the index ranges
 * that draw sub-square (depth, code) of a `quads` tile as (start, count) pairs into `out`
 * (capacity ≥ 10) and returns the number of pairs. Depth 0 is the whole tile (one range,
 * grid and edge skirts together); deeper sub-squares give one grid range plus the skirt
 * segments on their border that lie on a tile edge or a midline (at most 4; a quadrant gets
 * all four sides). Borders on other interior lines (depth ≥ 2 stand-ins) have no skirt.
 */
export function subSquareRanges(quads: number, depth: number, code: number, out: Int32Array): number {
  if (depth <= 0) { out[0] = 0; out[1] = tileIndexCount(quads); return 1; }
  const maxDepth = Math.log2(quads);
  if (depth > maxDepth) { code = code >>> (2 * (depth - maxDepth)); depth = maxDepth; }
  const N = quads, side = N >>> depth, quadCount = side * side;
  out[0] = code * quadCount * 6;
  out[1] = quadCount * 6;
  let n = 1, i0 = 0, j0 = 0;
  for (let d = 0; d < depth; d++) {
    const pair = (code >>> (2 * (depth - 1 - d))) & 3;
    const half = N >>> (d + 1);
    if (pair & 1) i0 += half;
    if (pair & 2) j0 += half;
  }
  const gridEnd = gridIndexCount(N), run = side * 6;
  if (j0 === 0) { out[2 * n] = gridEnd + i0 * 6; out[2 * n + 1] = run; n++; }
  if (j0 + side === N) { out[2 * n] = gridEnd + 6 * N + i0 * 6; out[2 * n + 1] = run; n++; }
  if (i0 === 0) { out[2 * n] = gridEnd + 12 * N + j0 * 6; out[2 * n + 1] = run; n++; }
  if (i0 + side === N) { out[2 * n] = gridEnd + 18 * N + j0 * 6; out[2 * n + 1] = run; n++; }
  // midline skirts (interior borders shared with sub-squares drawn by other tiles)
  const half = N >>> 1, mid = gridEnd + 24 * N;
  if (i0 + side === half) { out[2 * n] = mid + j0 * 6; out[2 * n + 1] = run; n++; }
  if (i0 === half) { out[2 * n] = mid + 6 * N + j0 * 6; out[2 * n + 1] = run; n++; }
  if (j0 + side === half) { out[2 * n] = mid + 12 * N + i0 * 6; out[2 * n + 1] = run; n++; }
  if (j0 === half) { out[2 * n] = mid + 18 * N + i0 * 6; out[2 * n + 1] = run; n++; }
  return n;
}
