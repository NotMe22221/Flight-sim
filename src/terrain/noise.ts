/**
 * Seeded 2-D simplex noise (Gustavson's reference algorithm) and fractal helpers.
 * Deterministic: the permutation table is shuffled with the project's mulberry32 PRNG.
 */
import { mulberry32 } from '../core/math';

const GRAD = new Float64Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1]);
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** 2-D simplex noise in roughly [−1, 1]. */
export class SimplexNoise2D {
  private readonly perm = new Uint8Array(512);
  private readonly permMod12 = new Uint8Array(512);

  constructor(seed: number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const rnd = mulberry32(seed);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  noise(xin: number, yin: number): number {
    const perm = this.perm, pm = this.permMod12;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = pm[ii + perm[jj]] * 2; t0 *= t0; n0 = t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = pm[ii + i1 + perm[jj + j1]] * 2; t1 *= t1; n1 = t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = pm[ii + 1 + perm[jj + 1]] * 2; t2 *= t2; n2 = t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2); }
    return 70 * (n0 + n1 + n2);
  }

  /** Fractional Brownian motion, normalised to roughly [−1, 1]. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let a = 1, f = 1, s = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      s += a * this.noise(x * f, y * f);
      norm += a;
      a *= gain;
      f *= lacunarity;
    }
    return s / norm;
  }

  /** Ridged multifractal in [0, ~1.94): sharp crests, good for mountain ranges. */
  ridged(x: number, y: number, octaves: number): number {
    let a = 1, f = 1, s = 0;
    for (let o = 0; o < octaves; o++) {
      const r = 1 - Math.abs(this.noise(x * f, y * f));
      s += a * r * r;
      a *= 0.5;
      f *= 2.1;
    }
    return s;
  }
}
