import { describe, expect, it } from 'vitest';
import { bilinearSample, extractSubGrid } from './sampling';

describe('extractSubGrid (parent-tile elevation fallback)', () => {
  // A plane h = 2·px + 3·py (in ancestor pixel units) is reproduced exactly by bilinear sampling.
  const W = 16;
  const plane = new Float32Array(W * W);
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) plane[j * W + i] = 2 * (i + 0.5) + 3 * (j + 0.5);

  it('depth 0 is a resample of the whole grid', () => {
    const out = extractSubGrid(plane, W, 0, 0, 0, W);
    for (let k = 0; k < out.length; k++) expect(out[k]).toBeCloseTo(plane[k], 4);
  });

  it('the SE quadrant (depth 1, offset 1,1) maps descendant pixel centres into the ancestor', () => {
    const out = extractSubGrid(plane, W, 1, 1, 1, W);
    // descendant pixel (i, j) centre → ancestor px = 8 + (i + 0.5)/2, py = 8 + (j + 0.5)/2
    for (const [i, j] of [[2, 2], [5, 9], [12, 3]] as const) {
      const px = 8 + (i + 0.5) / 2, py = 8 + (j + 0.5) / 2;
      expect(out[j * W + i]).toBeCloseTo(bilinearSample(plane, W, W, px, py), 4);
      expect(out[j * W + i]).toBeCloseTo(2 * px + 3 * py, 3);
    }
  });

  it('rejects offsets outside the ancestor', () => {
    expect(() => extractSubGrid(plane, W, 2, 4, 0, 8)).toThrow();
  });
});
