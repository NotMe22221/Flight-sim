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
 * i = 0..N), bottom (j = N), left (i = 0, j = 0..N), right (i = N), each N+1 vertices.
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

/** Number of vertices in a tile mesh with `quads` quads per side (grid + skirt). */
export const tileVertexCount = (quads: number): number => (quads + 1) * (quads + 1) + 4 * (quads + 1);
/** Number of indices of the main grid (6 per quad). */
export const gridIndexCount = (quads: number): number => 6 * quads * quads;
/** Total index count including the skirt (4·N skirt quads). */
export const tileIndexCount = (quads: number): number => 6 * (quads * quads + 4 * quads);

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
  const count = tileIndexCount(N);
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
    let a = i, b = i + 1, as = top + i, bs = top + i + 1;
    index[k++] = a; index[k++] = b; index[k++] = bs;
    index[k++] = a; index[k++] = bs; index[k++] = as;
    // bottom edge (south, j = N): outward +z → reversed winding
    a = N * W + i; b = a + 1; as = bottom + i; bs = bottom + i + 1;
    index[k++] = a; index[k++] = bs; index[k++] = b;
    index[k++] = a; index[k++] = as; index[k++] = bs;
  }
  for (let j = 0; j < N; j++) {
    // left edge (west, i = 0): outward −x → reversed winding
    let a = j * W, b = a + W, as = left + j, bs = left + j + 1;
    index[k++] = a; index[k++] = bs; index[k++] = b;
    index[k++] = a; index[k++] = as; index[k++] = bs;
    // right edge (east, i = N): outward +x
    a = j * W + N; b = a + W; as = right + j; bs = right + j + 1;
    index[k++] = a; index[k++] = b; index[k++] = bs;
    index[k++] = a; index[k++] = bs; index[k++] = as;
  }
  cache.set(quads, index);
  return index;
}

export interface IndexRange { start: number; count: number }

/**
 * Index range (into `gridIndex(quads)`) of the grid sub-square at `depth` levels below the
 * tile whose Morton path is `code` (bit pairs, most significant pair = first subdivision;
 * each pair = (y & 1) << 1 | (x & 1), i.e. 0 NW, 1 NE, 2 SW, 3 SE). `depth` is clamped to
 * log2(quads) (a single quad).
 */
export function quadrantGridRange(quads: number, depth: number, code: number): IndexRange {
  assertPow2(quads);
  const maxDepth = Math.log2(quads);
  if (depth > maxDepth) { code >>>= 2 * (depth - maxDepth); depth = maxDepth; }
  const quadsPerSide = quads >>> depth;
  const quadCount = quadsPerSide * quadsPerSide;
  return { start: code * quadCount * 6, count: quadCount * 6 };
}

/**
 * Skirt index ranges for the outer edges of the sub-square described by (depth, code):
 * segments of the tile's own skirt that lie on the sub-square's border. Interior edges
 * (shared with sibling sub-squares) have no skirt. Returns 0–2 ranges (4 at depth 0).
 */
export function quadrantSkirtRanges(quads: number, depth: number, code: number, out: IndexRange[] = []): IndexRange[] {
  assertPow2(quads);
  out.length = 0;
  const maxDepth = Math.log2(quads);
  if (depth > maxDepth) { code >>>= 2 * (depth - maxDepth); depth = maxDepth; }
  const N = quads;
  const side = N >>> depth; // quads per side of the sub-square
  // Sub-square origin in quad units: decode the path from the most significant pair down.
  let i0 = 0, j0 = 0;
  for (let d = 0; d < depth; d++) {
    const pair = (code >>> (2 * (depth - 1 - d))) & 3;
    const half = N >>> (d + 1);
    if (pair & 1) i0 += half;
    if (pair & 2) j0 += half;
  }
  const gridEnd = gridIndexCount(N);
  // Skirt layout per edge interleaves top/bottom per i and left/right per j (12 indices per step).
  const topBottomBase = gridEnd, leftRightBase = gridEnd + 12 * N;
  if (j0 === 0) out.push({ start: topBottomBase + i0 * 12, count: side * 12 }); // top (+ interleaved bottom quads)
  if (j0 + side === N) out.push({ start: topBottomBase + i0 * 12, count: side * 12 });
  if (i0 === 0) out.push({ start: leftRightBase + j0 * 12, count: side * 12 });
  if (i0 + side === N) out.push({ start: leftRightBase + j0 * 12, count: side * 12 });
  return out;
}
