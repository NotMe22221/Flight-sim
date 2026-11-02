/**
 * Superellipse loft: a smooth-shaded skin lofted through cross-section "stations" along the
 * model Z axis (nose −Z, tail +Z). Each station is a rounded rectangle (superellipse) with
 * its own width, height, vertical centre and corner exponent, so one generator produces
 * the cowling, the boxy cabin and the tapering tailcone.
 *
 * Parameterisation: `t` runs around the section with t = 0 at the bottom, π/2 on the right
 * (+X), π at the top, 3π/2 on the left. UVs: u = along the length (0 nose → 1 tail),
 * v = around (0 bottom → 1 bottom, 0.25 right, 0.5 top, 0.75 left).
 *
 * {@link buildLoftPatch} builds a sub-rectangle of the same surface (window glass, interior
 * lining) offset along the normal, so windows always hug the skin.
 */
import * as THREE from 'three';

export interface LoftStation {
  /** position along the model Z axis (m) */
  z: number;
  /** full width (m) */
  width: number;
  /** full height (m) */
  height: number;
  /** vertical centre of the section (m) */
  yCenter: number;
  /** superellipse exponent: 2 = ellipse, 3–4 = rounded rectangle */
  n: number;
}

const TWO_PI = Math.PI * 2;

/** Superellipse point for exponent n: sgn(c)|c|^(2/n). */
const sePow = (c: number, n: number): number => (c < 0 ? -1 : 1) * Math.pow(Math.abs(c), 2 / n);

/** A loft profile: interpolates stations and samples the skin surface. */
export class LoftProfile {
  readonly zMin: number;
  readonly zMax: number;
  private readonly tmp = new THREE.Vector3();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly tmpSec: LoftStation = { z: 0, width: 0, height: 0, yCenter: 0, n: 2 };

  constructor(readonly stations: readonly LoftStation[]) {
    if (stations.length < 2) throw new Error('LoftProfile needs at least 2 stations');
    for (let i = 1; i < stations.length; i++) {
      if (stations[i].z <= stations[i - 1].z) throw new Error('LoftProfile stations must have increasing z');
    }
    this.zMin = stations[0].z;
    this.zMax = stations[stations.length - 1].z;
  }

  /** Interpolated station parameters at z (clamped to the profile range). */
  sectionAt(z: number, out: LoftStation): LoftStation {
    const s = this.stations;
    if (z <= s[0].z) { Object.assign(out, s[0]); out.z = z; return out; }
    const last = s[s.length - 1];
    if (z >= last.z) { Object.assign(out, last); out.z = z; return out; }
    let i = 0;
    while (s[i + 1].z < z) i++;
    const a = s[i], b = s[i + 1];
    const f = (z - a.z) / (b.z - a.z);
    // smoothstep between stations gives C1 continuity across the stations
    const k = f * f * (3 - 2 * f);
    out.z = z;
    out.width = a.width + (b.width - a.width) * k;
    out.height = a.height + (b.height - a.height) * k;
    out.yCenter = a.yCenter + (b.yCenter - a.yCenter) * k;
    out.n = a.n + (b.n - a.n) * k;
    return out;
  }

  /** Surface point at (z, t). */
  pointAt(z: number, t: number, out: THREE.Vector3, section?: LoftStation): THREE.Vector3 {
    const s = section ?? this.sectionAt(z, { z: 0, width: 0, height: 0, yCenter: 0, n: 2 });
    // t = 0 bottom: use angle a = t − π/2 so that cos → x, sin → y with bottom at −π/2.
    const a = t - Math.PI / 2;
    out.x = (s.width / 2) * sePow(Math.cos(a), s.n);
    out.y = s.yCenter + (s.height / 2) * sePow(Math.sin(a), s.n);
    out.z = z;
    return out;
  }

  /** Outward unit normal at (z, t) by central differences. */
  normalAt(z: number, t: number, out: THREE.Vector3): THREE.Vector3 {
    const dz = 0.01, dt = 0.01;
    const z0 = Math.max(this.zMin, z - dz), z1 = Math.min(this.zMax, z + dz);
    this.pointAt(z1, t, this.tmpC).sub(this.pointAt(z0, t, this.tmpB)); // dP/dz
    this.pointAt(z, t + dt, this.tmpA).sub(this.pointAt(z, t - dt, this.tmpB)); // dP/dt
    out.crossVectors(this.tmpA, this.tmpC);
    if (out.lengthSq() < 1e-12) out.set(0, 1, 0);
    out.normalize();
    // make sure it points outward (away from the section centre)
    const c = this.sectionAt(z, this.tmpSec);
    this.pointAt(z, t, this.tmp, c);
    this.tmp.y -= c.yCenter; this.tmp.z = 0;
    if (out.dot(this.tmp) < 0) out.negate();
    return out;
  }
}

export interface LoftOptions {
  /** segments around the section (default 32) */
  radialSegments?: number;
  /** extra subdivisions between stations (default 3) */
  lengthSubdivisions?: number;
  /** close the front end with a fan (default true) */
  capFront?: boolean;
  /** close the back end with a fan (default true) */
  capBack?: boolean;
  /** invert winding/normals to build an interior lining (default false) */
  inside?: boolean;
  /**
   * z range mapped to u = 0..1 (default: the profile's own range). Give several lofts the
   * same range so one livery texture runs continuously across them.
   */
  uRange?: [number, number];
}

/**
 * Build the full closed loft surface as a smooth-shaded indexed BufferGeometry.
 */
export function buildLoft(profile: LoftProfile, opts: LoftOptions = {}): THREE.BufferGeometry {
  const radial = opts.radialSegments ?? 32;
  const sub = opts.lengthSubdivisions ?? 3;
  const capFront = opts.capFront ?? true;
  const capBack = opts.capBack ?? true;
  const inside = opts.inside ?? false;

  const zs: number[] = [];
  const st = profile.stations;
  for (let i = 0; i < st.length - 1; i++) {
    for (let k = 0; k < sub; k++) zs.push(st[i].z + ((st[i + 1].z - st[i].z) * k) / sub);
  }
  zs.push(st[st.length - 1].z);

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const p = new THREE.Vector3();
  const sec: LoftStation = { z: 0, width: 0, height: 0, yCenter: 0, n: 2 };
  const ringStride = radial + 1;
  const u0 = opts.uRange ? opts.uRange[0] : profile.zMin;
  const len = (opts.uRange ? opts.uRange[1] : profile.zMax) - u0 || 1;

  for (let i = 0; i < zs.length; i++) {
    profile.sectionAt(zs[i], sec);
    const u = (zs[i] - u0) / len;
    for (let j = 0; j <= radial; j++) {
      const t = (TWO_PI * j) / radial;
      profile.pointAt(zs[i], t, p, sec);
      positions.push(p.x, p.y, p.z);
      uvs.push(u, j / radial);
    }
  }
  for (let i = 0; i < zs.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * ringStride + j, b = a + 1, c = a + ringStride, d = c + 1;
      // outward winding (counter-clockwise seen from outside)
      if (inside) indices.push(a, c, b, b, c, d); else indices.push(a, b, c, b, d, c);
    }
  }
  const addCap = (ringIndex: number, front: boolean) => {
    profile.sectionAt(zs[ringIndex], sec);
    const ci = positions.length / 3;
    positions.push(0, sec.yCenter, zs[ringIndex]);
    uvs.push((zs[ringIndex] - u0) / len, 0.5);
    for (let j = 0; j < radial; j++) {
      const a = ringIndex * ringStride + j, b = a + 1;
      let fwd = front; if (inside) fwd = !fwd;
      if (fwd) indices.push(ci, b, a); else indices.push(ci, a, b);
    }
  };
  if (capFront) addCap(0, true);
  if (capBack) addCap(zs.length - 1, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

export interface LoftPatchSpec {
  z0: number; z1: number;
  /** around-parameter range (rad), t0 < t1, t = 0 bottom, π/2 right, π top, 3π/2 left */
  t0: number; t1: number;
  /** offset along the outward normal (m); negative = inside the skin */
  offset: number;
  /** face inward (for interior lining) */
  inside?: boolean;
  nz?: number; nt?: number;
}

/**
 * Build a rectangular patch of the loft surface, offset along the normal, as an indexed
 * BufferGeometry. Used for window glass (offset +0.01) and the cockpit lining (offset −0.03,
 * inside = true).
 */
export function buildLoftPatch(profile: LoftProfile, spec: LoftPatchSpec): THREE.BufferGeometry {
  const nz = spec.nz ?? Math.max(2, Math.ceil((spec.z1 - spec.z0) / 0.12));
  const nt = spec.nt ?? Math.max(2, Math.ceil((spec.t1 - spec.t0) / 0.12));
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  const sign = spec.inside ? -1 : 1;
  for (let i = 0; i <= nz; i++) {
    const z = spec.z0 + ((spec.z1 - spec.z0) * i) / nz;
    for (let j = 0; j <= nt; j++) {
      const t = spec.t0 + ((spec.t1 - spec.t0) * j) / nt;
      profile.pointAt(z, t, p);
      profile.normalAt(z, t, n);
      p.addScaledVector(n, spec.offset);
      positions.push(p.x, p.y, p.z);
      normals.push(n.x * sign, n.y * sign, n.z * sign);
      uvs.push(i / nz, j / nt);
    }
  }
  const stride = nt + 1;
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < nt; j++) {
      const a = i * stride + j, b = a + 1, c = a + stride, d = c + 1;
      if (spec.inside) indices.push(a, c, b, b, c, d); else indices.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  return g;
}
