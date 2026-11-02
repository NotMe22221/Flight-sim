import { describe, expect, it } from 'vitest';
import { descendantCode, gridIndex, gridIndexCount, mortonDecode, mortonEncode, quadrantGridRange, quadrantSkirtRanges, tileIndexCount, tileVertexCount } from './gridIndex';

describe('gridIndex', () => {
  it('morton round trip', () => {
    const out = [0, 0];
    for (let x = 0; x < 70; x += 7) for (let y = 0; y < 70; y += 5) { mortonDecode(mortonEncode(x, y), out); expect(out).toEqual([x, y]); }
    expect(mortonEncode(1, 0)).toBe(1);
    expect(mortonEncode(0, 1)).toBe(2);
  });

  it('64-quad index has 6·(64² + 4·64) entries referencing only valid vertices', () => {
    const idx = gridIndex(64);
    expect(idx.length).toBe(tileIndexCount(64));
    expect(idx.length).toBe(2 * 3 * (64 * 64 + 4 * 64));
    expect(idx).toBeInstanceOf(Uint16Array);
    const V = tileVertexCount(64);
    for (let i = 0; i < idx.length; i++) expect(idx[i]).toBeLessThan(V);
    expect(gridIndex(64)).toBe(idx); // cached
    expect(gridIndex(128)).toBeInstanceOf(Uint16Array); // 129² + 4·129 = 17157 fits
    expect(gridIndex(256)).toBeInstanceOf(Uint32Array); // 257² > 65535
  });

  it('every grid quad appears exactly once (Morton order covers the grid)', () => {
    const N = 8, W = N + 1, idx = gridIndex(N);
    const seen = new Set<number>();
    for (let q = 0; q < N * N; q++) {
      const v0 = idx[q * 6];
      expect(seen.has(v0)).toBe(false);
      seen.add(v0);
      expect(v0 % W).toBeLessThan(N);
      expect(Math.floor(v0 / W)).toBeLessThan(N);
    }
    expect(seen.size).toBe(N * N);
  });

  it('quadrant ranges partition the grid and skirt ranges hug the sub-square border', () => {
    const N = 8;
    const ranges = [0, 1, 2, 3].map((c) => quadrantGridRange(N, 1, c));
    expect(ranges.map((r) => r.start)).toEqual([0, 96, 192, 288]);
    expect(ranges.every((r) => r.count === 96)).toBe(true);
    const full = quadrantGridRange(N, 0, 0);
    expect(full).toEqual({ start: 0, count: gridIndexCount(N) });
    // NW quadrant: top + left edges, each 4 quads of the 8-quad edge
    const nw = quadrantSkirtRanges(N, 1, 0);
    expect(nw).toEqual([{ start: 384, count: 24 }, { start: 384 + 96, count: 24 }]);
    // SE quadrant: bottom + right edges, offset by 4 quads
    const se = quadrantSkirtRanges(N, 1, 3);
    expect(se).toEqual([{ start: 384 + 48 + 24, count: 24 }, { start: 384 + 144 + 24, count: 24 }]);
    expect(quadrantSkirtRanges(N, 0, 0).length).toBe(4);
    // depth beyond the grid resolution clamps to a single quad
    expect(quadrantGridRange(N, 5, 0b1111111111).count).toBe(6);
  });

  it('descendantCode gives the Morton path of a child inside its ancestor', () => {
    expect(descendantCode(14, 15, 2 * 100 + 1, 2 * 50)).toBe(1); // NE child
    expect(descendantCode(13, 15, 4 * 7 + 2, 4 * 3 + 3)).toBe(mortonEncode(2, 3));
  });
});
