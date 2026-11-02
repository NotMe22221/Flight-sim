/**
 * Terrarium RGB elevation encoding (Tilezen / Mapzen Terrain Tiles, Mapterhorn):
 *
 *     h = R * 256 + G + B / 256 - 32768          (metres, 1/256 m steps)
 *
 * Pure functions, no DOM. PNG bytes are decoded with `fast-png` so that the exact same
 * code path runs in the worker and in Node tests (a canvas-based decode could be
 * colour-managed by the browser and corrupt the bytes).
 */
import { decode as decodePng, encode as encodePng } from 'fast-png';

/** Valid Terrarium range; anything outside is treated as no-data. */
export const TERRARIUM_MIN_VALID = -11000;
export const TERRARIUM_MAX_VALID = 9000;
/** Value used for pixels that have no valid data and no valid predecessor in scan order. */
export const TERRARIUM_NODATA_FILL = 0;

export interface DecodedHeights {
  /** row-major, row 0 = north edge, `width * height` entries, metres */
  heights: Float32Array;
  width: number;
  height: number;
  minH: number;
  maxH: number;
  /** number of pixels replaced by the no-data guard */
  noDataCount: number;
}

/**
 * Decode raw 8-bit RGB(A) pixel bytes into heights.
 * No-data pixels (outside −11000…9000 m) are replaced with the previous valid pixel in scan
 * order (or 0 for a leading run) so a corrupt pixel never produces a 9 km spike.
 */
export function decodeTerrarium(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: 3 | 4,
  out?: Float32Array,
): DecodedHeights {
  const n = width * height;
  if (data.length < n * channels) throw new Error(`decodeTerrarium: expected ${n * channels} bytes, got ${data.length}`);
  const heights = out && out.length === n ? out : new Float32Array(n);
  let minH = Infinity, maxH = -Infinity, noDataCount = 0, last = TERRARIUM_NODATA_FILL;
  for (let i = 0, p = 0; i < n; i++, p += channels) {
    let h = data[p] * 256 + data[p + 1] + data[p + 2] * (1 / 256) - 32768;
    if (h < TERRARIUM_MIN_VALID || h > TERRARIUM_MAX_VALID || h !== h) { h = last; noDataCount++; }
    else last = h;
    heights[i] = h;
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  return { heights, width, height, minH, maxH, noDataCount };
}

/**
 * Encode heights to Terrarium bytes (RGBA by default, RGB when `channels === 3`).
 * Heights are quantised to 1/256 m and clamped to the encodable range −32768…32767.996.
 */
export function encodeTerrarium(heights: ArrayLike<number>, width: number, height: number, channels: 3 | 4 = 4, out?: Uint8Array): Uint8Array {
  const n = width * height;
  if (heights.length < n) throw new Error(`encodeTerrarium: expected ${n} heights, got ${heights.length}`);
  const bytes = out && out.length === n * channels ? out : new Uint8Array(n * channels);
  for (let i = 0, p = 0; i < n; i++, p += channels) {
    let v = Math.round((heights[i] + 32768) * 256);
    if (v < 0) v = 0; else if (v > 0xffffff) v = 0xffffff;
    bytes[p] = v >>> 16;
    bytes[p + 1] = (v >>> 8) & 0xff;
    bytes[p + 2] = v & 0xff;
    if (channels === 4) bytes[p + 3] = 255;
  }
  return bytes;
}

/** Decode a Terrarium PNG file (ArrayBuffer or byte view) into heights. Accepts RGB and RGBA 8-bit PNGs. */
export function decodeTerrariumPng(png: ArrayBuffer | ArrayBufferView, out?: Float32Array): DecodedHeights {
  const bytes = png instanceof ArrayBuffer ? new Uint8Array(png) : new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
  const img = decodePng(bytes);
  if (img.depth !== 8) throw new Error(`decodeTerrariumPng: unsupported bit depth ${img.depth}`);
  if (img.channels !== 3 && img.channels !== 4) throw new Error(`decodeTerrariumPng: unsupported channel count ${img.channels}`);
  if (img.data instanceof Uint16Array) throw new Error('decodeTerrariumPng: 16-bit data not supported');
  return decodeTerrarium(img.data, img.width, img.height, img.channels, out);
}

/** Encode heights into a Terrarium RGB PNG (used by tests and to synthesise fixtures). */
export function encodeTerrariumPng(heights: ArrayLike<number>, width: number, height: number): Uint8Array {
  const data = encodeTerrarium(heights, width, height, 3);
  return encodePng({ width, height, data, channels: 3, depth: 8 });
}
