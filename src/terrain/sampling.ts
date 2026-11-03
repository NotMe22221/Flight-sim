/**
 * Bilinear sampling of a row-major height grid whose pixel centres sit at +0.5
 * (pixel (i, j) covers [i, i+1) × [j, j+1) of the tile in pixel units).
 * Shared by the mesh builder (vertex heights), the heightfield (collision queries),
 * runway flattening and the procedural imagery generator.
 */

/**
 * Sample the grid at continuous pixel coordinates `(px, py)` measured in pixels from the
 * tile's NW corner (so `px = u * width` for a normalised `u`). Clamps at the borders.
 */
export function bilinearSample(heights: ArrayLike<number>, width: number, height: number, px: number, py: number): number {
  let fx = px - 0.5, fy = py - 0.5;
  const maxX = width - 1, maxY = height - 1;
  if (fx < 0) fx = 0; else if (fx > maxX) fx = maxX;
  if (fy < 0) fy = 0; else if (fy > maxY) fy = maxY;
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
 * written to `out[0]`, `out[1]`. Uses the same cell as `bilinearSample`.
 */
export function bilinearGradient(heights: ArrayLike<number>, width: number, height: number, px: number, py: number, out: Float64Array | number[]): void {
  let fx = px - 0.5, fy = py - 0.5;
  const maxX = width - 1, maxY = height - 1;
  if (fx < 0) fx = 0; else if (fx > maxX) fx = maxX;
  if (fy < 0) fy = 0; else if (fy > maxY) fy = maxY;
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
