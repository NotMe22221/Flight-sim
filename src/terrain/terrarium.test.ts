import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lonLatToTile } from '../geo/mercator';
import { bilinearSample } from './sampling';
import { decodeTerrarium, decodeTerrariumPng, encodeTerrarium, encodeTerrariumPng } from './terrarium';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));

describe('terrarium decode', () => {
  it('KSFO z15 tile 5246/12684 pixel (199,20) ≈ 3.96 m (runway 28R threshold)', () => {
    const d = decodeTerrariumPng(fixture('terrarium-15-5246-12684.png'));
    expect(d.width).toBe(256);
    expect(d.height).toBe(256);
    expect(d.noDataCount).toBe(0);
    expect(d.heights[20 * 256 + 199]).toBeCloseTo(3.96, 1);
    expect(Math.abs(d.heights[20 * 256 + 199] - 3.96)).toBeLessThan(0.05);
    expect(d.minH).toBeLessThan(d.maxH);
  });

  it('LOWI z15 tile 17415/11490 pixel (93,189) ≈ 581.4 m (runway 08 threshold)', () => {
    const d = decodeTerrariumPng(fixture('terrarium-15-17415-11490.png'));
    expect(Math.abs(d.heights[189 * 256 + 93] - 581.4)).toBeLessThan(0.1);
  });

  it('SF Bay z12 at (−122.30, 37.60) ≈ −3.2 m (water, negative)', () => {
    // (−122.30, 37.60) lies in z12 tile 656/1585 (tile 655 ends at lon −122.34); both are fixtures.
    const t = lonLatToTile(-122.3, 37.6, 12);
    expect(Math.floor(t.x)).toBe(656);
    expect(Math.floor(t.y)).toBe(1585);
    const d = decodeTerrariumPng(fixture('terrarium-12-656-1585.png'));
    const h = bilinearSample(d.heights, 256, 256, (t.x % 1) * 256, (t.y % 1) * 256);
    expect(Math.abs(h - -3.2)).toBeLessThan(0.5);
    expect(h).toBeLessThan(0);
    // the neighbouring tile 655/1585 holds the bay north of SFO: negative along its top edge
    const d655 = decodeTerrariumPng(fixture('terrarium-12-655-1585.png'));
    expect(d655.heights[192]).toBeLessThan(-2.5);
    expect(d655.minH).toBeLessThan(0);
  });

  it('encode → decode round trip is exact to 1/256 m', () => {
    const w = 16, n = w * w;
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) src[i] = -500 + (i * 37.123) % 4000 + ((i * 7) % 256) / 256;
    const bytes = encodeTerrarium(src, w, w, 4);
    const d = decodeTerrarium(bytes, w, w, 4);
    for (let i = 0; i < n; i++) expect(Math.abs(d.heights[i] - src[i])).toBeLessThanOrEqual(1 / 256 + 1e-6);
    const png = encodeTerrariumPng(src, w, w);
    const d2 = decodeTerrariumPng(png);
    expect(d2.width).toBe(w);
    for (let i = 0; i < n; i++) expect(Math.abs(d2.heights[i] - src[i])).toBeLessThanOrEqual(1 / 256 + 1e-6);
    // exact grid values survive bit-exactly
    const exact = new Float32Array([0, 1, 1.5, -1, 1234.25, -10999.5, 8848.99609375, 100.00390625, 7, 8, 9, 10, 11, 12, 13, 14]);
    const d3 = decodeTerrarium(encodeTerrarium(exact, 4, 4, 3), 4, 4, 3);
    for (let i = 0; i < 16; i++) expect(d3.heights[i]).toBe(exact[i]);
  });

  it('no-data guard replaces out-of-range values with the previous valid pixel', () => {
    const w = 4, bytes = encodeTerrarium(new Float32Array(16).fill(10), w, w, 4);
    bytes[4 * 5] = 255; bytes[4 * 5 + 1] = 255; bytes[4 * 5 + 2] = 255; // pixel 5 → 32767.99 m (invalid)
    bytes[0] = 0; bytes[1] = 0; bytes[2] = 0;                           // pixel 0 → −32768 m (invalid, leading)
    const d = decodeTerrarium(bytes, w, w, 4);
    expect(d.noDataCount).toBe(2);
    expect(d.heights[5]).toBe(10);
    expect(d.heights[0]).toBe(0);
    expect(d.maxH).toBe(10);
  });
});
