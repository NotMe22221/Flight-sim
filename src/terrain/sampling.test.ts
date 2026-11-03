import { describe, expect, it } from 'vitest';
import { gridIndex, gridIndexCount } from './gridIndex';
import { bilinearSample, extractSubGrid, triangleGradient, triangleSample } from './sampling';

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

describe('triangleSample (heights on the drawn mesh triangles)', () => {
  const N = 4, W = N + 1;
  const lattice = new Float32Array(W * W);
  for (let k = 0; k < lattice.length; k++) lattice[k] = ((k * 7919) % 23) - 11; // rough, deterministic

  /** Barycentric interpolation on whichever gridIndex triangle contains (u, v) — the reference. */
  function onIndexTriangles(u: number, v: number): number {
    const idx = gridIndex(N);
    const px = u * N, py = v * N;
    for (let t = 0; t < gridIndexCount(N); t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const ax = a % W, ay = (a - ax) / W, bx = b % W, by = (b - bx) / W, cx = c % W, cy = (c - cx) / W;
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      const wa = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
      const wb = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
      const wc = 1 - wa - wb;
      if (wa >= -1e-9 && wb >= -1e-9 && wc >= -1e-9) return wa * lattice[a] + wb * lattice[b] + wc * lattice[c];
    }
    throw new Error('outside the grid');
  }

  it('equals the gridIndex triangles everywhere (same diagonal), and the vertices exactly', () => {
    for (let k = 0; k < 400; k++) {
      const u = ((k * 0.6180339887) % 1), v = ((k * 0.4142135623) % 1);
      expect(triangleSample(lattice, N, u, v)).toBeCloseTo(onIndexTriangles(u, v), 9);
    }
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) expect(triangleSample(lattice, N, i / N, j / N)).toBeCloseTo(lattice[j * W + i], 9);
    // clamped outside the tile
    expect(triangleSample(lattice, N, -0.5, -0.5)).toBe(lattice[0]);
    expect(triangleSample(lattice, N, 1.5, 1.5)).toBe(lattice[W * W - 1]);
  });

  it('gradient is the face slope (finite differences inside one triangle)', () => {
    const g = [0, 0];
    for (const [u, v] of [[0.1, 0.1], [0.2, 0.2], [0.61, 0.37], [0.9, 0.95]] as const) {
      triangleGradient(lattice, N, u, v, g);
      const e = 1e-6;
      expect(g[0]).toBeCloseTo((triangleSample(lattice, N, u + e, v) - triangleSample(lattice, N, u - e, v)) / (2 * e * N), 4);
      expect(g[1]).toBeCloseTo((triangleSample(lattice, N, u, v + e) - triangleSample(lattice, N, u, v - e)) / (2 * e * N), 4);
    }
  });
});
