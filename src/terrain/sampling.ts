/**
 * Bilinear sampling of a row-major height grid whose pixel centres sit at +0.5
 * (pixel (i, j) covers [i, i+1) × [j, j+1) of the tile in pixel units).
 * Shared by the mesh builder (vertex heights), the heightfield (collision queries),
 * runway flattening and the procedural imagery generator.
 */

/**
 * Sample the grid at continuous pixel coordinates `(px, py)` measured in pixels from the
 * tile's NW corner (so `px = u * width` for a normalised `u`).
 *
 * Between the outermost pixel centres and the tile border (the last half pixel) the edge cell
 * is extrapolated linearly, and coordinates beyond the border are clamped to it. A tile edge
 * (px = 0 or width) therefore gets the surface value *at the edge* rather than the edge pixel's
 * centre value half a pixel inside: two neighbouring tiles then agree on their shared edge to
 * first order, instead of differing by one pixel of slope (2 m on a 30° slope at z15, 17 m at z12).
 */
export function bilinearSample(heights: ArrayLike<number>, width: number, height: number, px: number, py: number): number {
  let fx = px - 0.5, fy = py - 0.5;
  const maxX = width - 1, maxY = height - 1;
  if (fx < -0.5) fx = -0.5; else if (fx > maxX + 0.5) fx = maxX + 0.5;
  if (fy < -0.5) fy = -0.5; else if (fy > maxY + 0.5) fy = maxY + 0.5;
  let x0 = Math.floor(fx), y0 = Math.floor(fy);
  if (x0 >= maxX) x0 = maxX - 1;
  if (y0 >= maxY) y0 = maxY - 1;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  const tx = fx - x0, ty = fy - y0;
  const i = y0 * width + x0;
  const h00 = heights[i], h10 = heights[i + 1], h01 = heights[i + width], h11 = heights[i + width + 1];
  const a = h00 + (h10 - h00) * tx;
  const b = h01 + (h11 - h01) * tx;
  return a + (b - a) * ty;
}

/**
 * Bilinear gradient (∂h/∂px, ∂h/∂py) in metres per pixel at continuous pixel coordinates,
 * written to `out[0]`, `out[1]`. Uses the same cell (and edge extrapolation) as `bilinearSample`.
 */
export function bilinearGradient(heights: ArrayLike<number>, width: number, height: number, px: number, py: number, out: Float64Array | number[]): void {
  let fx = px - 0.5, fy = py - 0.5;
  const maxX = width - 1, maxY = height - 1;
  if (fx < -0.5) fx = -0.5; else if (fx > maxX + 0.5) fx = maxX + 0.5;
  if (fy < -0.5) fy = -0.5; else if (fy > maxY + 0.5) fy = maxY + 0.5;
  let x0 = Math.floor(fx), y0 = Math.floor(fy);
  if (x0 >= maxX) x0 = maxX - 1;
  if (y0 >= maxY) y0 = maxY - 1;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  const tx = fx - x0, ty = fy - y0;
  const i = y0 * width + x0;
  const h00 = heights[i], h10 = heights[i + 1], h01 = heights[i + width], h11 = heights[i + width + 1];
  out[0] = (h10 - h00) * (1 - ty) + (h11 - h01) * ty;
  out[1] = (h01 - h00) * (1 - tx) + (h11 - h10) * tx;
}

/**
 * Height on the drawn tile surface: `lattice` holds the (quads+1)² vertex heights of a tile
 * mesh (vertex (i, j) at tile fraction (i/quads, j/quads), row 0 = north) and the value is
 * interpolated on the mesh's own triangles — each quad split along its NE–SW diagonal, as in
 * gridIndex.ts — so that it equals the rendered surface, not a smoother bilinear DEM.
 * `(u, v)` are tile fractions (east, south) in [0, 1]; values outside are clamped to the edge quads.
 */
export function triangleSample(lattice: ArrayLike<number>, quads: number, u: number, v: number): number {
  const W = quads + 1;
  const gx = u * quads, gy = v * quads;
  let i = Math.floor(gx), j = Math.floor(gy);
  if (i < 0) i = 0; else if (i > quads - 1) i = quads - 1;
  if (j < 0) j = 0; else if (j > quads - 1) j = quads - 1;
  let fx = gx - i, fy = gy - j;
  if (fx < 0) fx = 0; else if (fx > 1) fx = 1;
  if (fy < 0) fy = 0; else if (fy > 1) fy = 1;
  const k = j * W + i;
  const h0 = lattice[k], h1 = lattice[k + 1], h2 = lattice[k + W], h3 = lattice[k + W + 1];
  // NW triangle (NW, SW, NE) when fx + fy ≤ 1, else SE triangle (NE, SW, SE)
  return fx + fy <= 1 ? h0 + (h1 - h0) * fx + (h2 - h0) * fy : h3 + (h2 - h3) * (1 - fx) + (h1 - h3) * (1 - fy);
}

/**
 * Gradient of `triangleSample` (the face slope of the triangle under (u, v)) in metres per
 * quad: out[0] = ∂h/∂east, out[1] = ∂h/∂south.
 */
export function triangleGradient(lattice: ArrayLike<number>, quads: number, u: number, v: number, out: Float64Array | number[]): void {
  const W = quads + 1;
  const gx = u * quads, gy = v * quads;
  let i = Math.floor(gx), j = Math.floor(gy);
  if (i < 0) i = 0; else if (i > quads - 1) i = quads - 1;
  if (j < 0) j = 0; else if (j > quads - 1) j = quads - 1;
  const k = j * W + i;
  const h0 = lattice[k], h1 = lattice[k + 1], h2 = lattice[k + W], h3 = lattice[k + W + 1];
  if (gx - i + (gy - j) <= 1) { out[0] = h1 - h0; out[1] = h2 - h0; } else { out[0] = h3 - h2; out[1] = h3 - h1; }
}

/** Box-filter downsample of a square grid by an integer factor (e.g. 256 → 64). */
export function downsampleGrid(src: Float32Array, width: number, factor: number, out?: Float32Array): Float32Array {
  const w = width / factor;
  if (!Number.isInteger(w)) throw new Error(`downsampleGrid: ${width} not divisible by ${factor}`);
  const dst = out && out.length === w * w ? out : new Float32Array(w * w);
  const inv = 1 / (factor * factor);
  for (let j = 0; j < w; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (j * factor + dy) * width + i * factor;
        for (let dx = 0; dx < factor; dx++) s += src[row + dx];
      }
      dst[j * w + i] = s * inv;
    }
  }
  return dst;
}

/**
 * Upsample the part of an ancestor tile's grid that covers one of its descendants: the
 * descendant `depth` levels below at offset (sx, sy), in descendant tiles from the ancestor's
 * NW corner (0 ≤ sx, sy < 2^depth). The result is `outWidth`² heights sampled bilinearly at
 * the descendant's own pixel centres (row 0 = north) — the "parent tile" elevation fallback.
 */
export function extractSubGrid(
  src: ArrayLike<number>, srcWidth: number,
  depth: number, sx: number, sy: number,
  outWidth: number, out?: Float32Array,
): Float32Array {
  const n = 2 ** depth;
  if (sx < 0 || sy < 0 || sx >= n || sy >= n) throw new Error(`extractSubGrid: offset (${sx}, ${sy}) outside 2^${depth}`);
  const dst = out && out.length === outWidth * outWidth ? out : new Float32Array(outWidth * outWidth);
  const scale = srcWidth / (n * outWidth); // ancestor pixels per descendant pixel
  const ox = (sx * srcWidth) / n, oy = (sy * srcWidth) / n;
  for (let j = 0; j < outWidth; j++) {
    const py = oy + (j + 0.5) * scale;
    const row = j * outWidth;
    for (let i = 0; i < outWidth; i++) dst[row + i] = bilinearSample(src, srcWidth, srcWidth, ox + (i + 0.5) * scale, py);
  }
  return dst;
}
