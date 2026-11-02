/**
 * Small numeric helpers shared by every module. Hot loops inside modules may
 * keep their own Float64Array-based versions; these are the canonical semantics.
 *
 * Quaternions are scalar-first [w, x, y, z]. Vectors are [x, y, z].
 */
import type { Quat, Vec3 } from './types';

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Wrap angle to [-π, π). */
export const wrapPi = (a: number): number => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};
/** Wrap angle to [0, 2π). */
export const wrapTwoPi = (a: number): number => {
  let x = a % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x;
};
/** Wrap degrees to [0, 360). */
export const wrap360 = (d: number): number => {
  let x = d % 360;
  if (x < 0) x += 360;
  return x;
};
/** Signed shortest difference a-b in degrees, in (-180, 180]. */
export const deltaDeg = (a: number, b: number): number => {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
};

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const v3add = (a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 => {
  out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; return out;
};
export const v3sub = (a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 => {
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; return out;
};
export const v3scale = (a: Vec3, s: number, out: Vec3 = [0, 0, 0]): Vec3 => {
  out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s; return out;
};
export const v3dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const v3cross = (a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 => {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z; return out;
};
export const v3len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const v3norm = (a: Vec3, out: Vec3 = [0, 0, 0]): Vec3 => {
  const l = v3len(a) || 1;
  out[0] = a[0] / l; out[1] = a[1] / l; out[2] = a[2] / l; return out;
};

export const qIdentity = (): Quat => [1, 0, 0, 0];
export const qNormalize = (q: Quat, out: Quat = [1, 0, 0, 0]): Quat => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  out[0] = q[0] / l; out[1] = q[1] / l; out[2] = q[2] / l; out[3] = q[3] / l; return out;
};
export const qConj = (q: Quat, out: Quat = [1, 0, 0, 0]): Quat => {
  out[0] = q[0]; out[1] = -q[1]; out[2] = -q[2]; out[3] = -q[3]; return out;
};
/** Hamilton product a ⊗ b. */
export const qMul = (a: Quat, b: Quat, out: Quat = [1, 0, 0, 0]): Quat => {
  const w = a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3];
  const x = a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2];
  const y = a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1];
  const z = a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0];
  out[0] = w; out[1] = x; out[2] = y; out[3] = z; return out;
};
/** Rotate vector v by quaternion q (v' = q v q*). */
export const qRotate = (q: Quat, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 => {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  // v' = v + w*t + cross(q.xyz, t)
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out;
};
/** Quaternion from Z-Y-X Euler angles (yaw ψ, pitch θ, roll φ): rotates NED → body when used as q_nb. */
export const qFromEuler = (roll: number, pitch: number, yaw: number, out: Quat = [1, 0, 0, 0]): Quat => {
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  // This is q_bn (body → NED, i.e. the orientation of the body in NED). Conjugate for q_nb.
  out[0] = cr * cp * cy + sr * sp * sy;
  out[1] = sr * cp * cy - cr * sp * sy;
  out[2] = cr * sp * cy + sr * cp * sy;
  out[3] = cr * cp * sy - sr * sp * cy;
  return out;
};
/** Euler angles [roll, pitch, yaw] from an orientation quaternion q_bn (body → NED). */
export const eulerFromQ = (q: Quat, out: Vec3 = [0, 0, 0]): Vec3 => {
  const [w, x, y, z] = q;
  out[0] = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  out[1] = Math.asin(clamp(2 * (w * y - z * x), -1, 1));
  out[2] = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return out;
};
/** Spherical linear interpolation (shortest arc). */
export const qSlerp = (a: Quat, b: Quat, t: number, out: Quat = [1, 0, 0, 0]): Quat => {
  let bw = b[0], bx = b[1], by = b[2], bz = b[3];
  let cos = a[0] * bw + a[1] * bx + a[2] * by + a[3] * bz;
  if (cos < 0) { cos = -cos; bw = -bw; bx = -bx; by = -by; bz = -bz; }
  let ka: number, kb: number;
  if (cos > 0.9995) { ka = 1 - t; kb = t; }
  else {
    const th = Math.acos(cos), s = Math.sin(th);
    ka = Math.sin((1 - t) * th) / s; kb = Math.sin(t * th) / s;
  }
  out[0] = ka * a[0] + kb * bw; out[1] = ka * a[1] + kb * bx; out[2] = ka * a[2] + kb * by; out[3] = ka * a[3] + kb * bz;
  return qNormalize(out, out);
};

/** 1-D table with linear interpolation, clamped at the ends. xs must be ascending. */
export class Table1D {
  constructor(public readonly xs: ArrayLike<number>, public readonly ys: ArrayLike<number>) {
    if (xs.length !== ys.length || xs.length < 1) throw new Error('Table1D: bad sizes');
  }
  at(x: number): number {
    const xs = this.xs, ys = this.ys, n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return ys[lo] + (ys[hi] - ys[lo]) * t;
  }
}

/** 2-D table (rows × cols) with bilinear interpolation, clamped. */
export class Table2D {
  constructor(
    public readonly rows: ArrayLike<number>,
    public readonly cols: ArrayLike<number>,
    /** row-major, rows.length * cols.length */
    public readonly data: ArrayLike<number>,
  ) {
    if (data.length !== rows.length * cols.length) throw new Error('Table2D: bad sizes');
  }
  private static idx(xs: ArrayLike<number>, x: number): [number, number] {
    const n = xs.length;
    if (n === 1 || x <= xs[0]) return [0, 0];
    if (x >= xs[n - 1]) return [n - 1, 0];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    return [lo, (x - xs[lo]) / (xs[hi] - xs[lo])];
  }
  at(r: number, c: number): number {
    const [i, ti] = Table2D.idx(this.rows, r);
    const [j, tj] = Table2D.idx(this.cols, c);
    const nc = this.cols.length;
    const i1 = Math.min(i + 1, this.rows.length - 1), j1 = Math.min(j + 1, nc - 1);
    const d = this.data;
    const a = d[i * nc + j] + (d[i * nc + j1] - d[i * nc + j]) * tj;
    const b = d[i1 * nc + j] + (d[i1 * nc + j1] - d[i1 * nc + j]) * tj;
    return a + (b - a) * ti;
  }
}

/** Deterministic PRNG (mulberry32) so turbulence and procedural terrain are reproducible. */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
/** Standard normal via Box–Muller from a uniform generator. */
export const gaussian = (rnd: () => number): number => {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
