/**
 * Fuselage skin regions with exact window cut-outs.
 *
 * Windows, door seams and frames are described as rounded convex outlines in the *side view*
 * (z, y) of the fuselage and turned into signed distance fields of the model-space point
 * (negative inside). {@link buildSkin} lofts a (z, t) grid over a {@link LoftProfile}, keeps
 * the parts where every constraint field is ≥ 0 and clips the grid cells along the zero level
 * set (bisection on the true field), so window edges are smooth curves instead of grid steps.
 * All normals are analytic, so separately built regions (cowl, cabin, tailcone, glass) shade
 * seamlessly where they meet.
 */
import * as THREE from 'three';
import type { LoftProfile, LoftStation } from './loft';

/** Point in the side view: [z, y] (m). */
export type SideXY = [number, number];

/** A window / panel outline on the fuselage skin. */
export interface SkinOutline {
  name: string;
  /**
   * convex outline, counter-clockwise: in the side view (z, y) with z to the right, y up, or for
   * `view: 'top'` in the top view (z, x) with z to the right, x up
   */
  outline: SideXY[];
  /** corner radius, m */
  radius: number;
  /** which half of the fuselage: right (+X), left (−X) or both (windshield, rear window) */
  side: 'right' | 'left' | 'both';
  /** 'side' (default) or 'top' (roof windows such as a skylight) */
  view?: 'side' | 'top';
  /** top-view outlines only apply above this height (model y), so the belly is never cut */
  minY?: number;
}

/** Signed distance (m, negative inside) of a model-space point. */
export type SkinField = (x: number, y: number, z: number) => number;

/** Mirror a right-side outline to the left side. */
export function mirrorOutline(o: SkinOutline, name: string): SkinOutline {
  return { ...o, name, side: o.side === 'right' ? 'left' : o.side === 'left' ? 'right' : 'both' };
}

/** Exact signed distance to a convex CCW polygon. */
function convexSdf(poly: SideXY[], pz: number, py: number): number {
  let inside = true, maxIn = -Infinity, minOut = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [az, ay] = poly[i], [bz, by] = poly[(i + 1) % poly.length];
    const ez = bz - az, ey = by - ay;
    const len = Math.hypot(ez, ey) || 1;
    // inward (left) normal distance
    const d = (-(ey) * (pz - az) + ez * (py - ay)) / len;
    if (d < 0) inside = false;
    maxIn = Math.max(maxIn, -d);
    const s = Math.max(0, Math.min(1, ((pz - az) * ez + (py - ay) * ey) / (len * len)));
    minOut = Math.min(minOut, Math.hypot(pz - (az + ez * s), py - (ay + ey * s)));
  }
  return inside ? maxIn : minOut;
}

/**
 * Offset a convex CCW polygon inward by r: the intersection of the inward-offset edge
 * half-planes, clipped from a bounding box, so edges shorter than the offset collapse cleanly
 * instead of folding the polygon over.
 */
export function shrinkConvex(poly: SideXY[], r: number): SideXY[] {
  if (r <= 0) return poly;
  let minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [z, y] of poly) { minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  let out: SideXY[] = [[minZ - 1, minY - 1], [maxZ + 1, minY - 1], [maxZ + 1, maxY + 1], [minZ - 1, maxY + 1]];
  for (let i = 0; i < poly.length && out.length >= 3; i++) {
    const [az, ay] = poly[i], [bz, by] = poly[(i + 1) % poly.length];
    const ez = bz - az, ey = by - ay, len = Math.hypot(ez, ey);
    if (len < 1e-12) continue;
    // keep n·(p − a) ≥ r with the inward (left) normal n
    const side = (q: SideXY) => (-ey * (q[0] - az) + ez * (q[1] - ay)) / len - r;
    const next: SideXY[] = [];
    for (let k = 0; k < out.length; k++) {
      const p = out[k], q = out[(k + 1) % out.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const s = sp / (sp - sq); next.push([p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s]); }
    }
    out = next;
  }
  return out;
}

/** Field of a rounded outline (negative inside); +1 on the other half of the fuselage. */
export function outlineField(o: SkinOutline): SkinField {
  const core = shrinkConvex(o.outline, o.radius);
  const r = o.radius;
  if (o.view === 'top') {
    const minY = o.minY ?? -Infinity;
    return (x, y, z) => {
      if (y < minY || (o.side === 'right' && x <= 0) || (o.side === 'left' && x >= 0)) return 1;
      return convexSdf(core, z, x) - r;
    };
  }
  return (x, y, z) => {
    if ((o.side === 'right' && x <= 0) || (o.side === 'left' && x >= 0)) return 1;
    return convexSdf(core, z, y) - r;
  };
}

/** A region is kept where every constraint is ≥ 0. */
export type Constraint = SkinField;

export interface SkinOptions {
  z0: number;
  z1: number;
  /** target row spacing along z (default 0.05 m) */
  dz?: number;
  /** columns around the section (default 72) */
  radial?: number;
  /** offset along the outward normal (m) */
  offset?: number;
  /** face inward (cockpit lining) */
  inside?: boolean;
  /** keep only where all constraints are ≥ 0 */
  keep?: Constraint[];
  /** z range mapped to u = 0..1 (livery) */
  uRange?: [number, number];
  /**
   * Record the cut edges of these constraints (indices into `keep`) and build reveal ribbons
   * from `offset` to `revealTo` facing into the cut-out (window frames seen from inside).
   */
  reveal?: { constraints: number[]; to: number };
}

export interface SkinResult {
  geometry: THREE.BufferGeometry;
  /** window reveal ribbons (empty geometry when not requested) */
  reveal: THREE.BufferGeometry;
}

interface PT { z: number; t: number; g: number[] }

const TWO_PI = Math.PI * 2;

/**
 * Build a skin region of `profile` (non-indexed, analytic normals, livery UVs: u along z,
 * v = 0 bottom → 0.25 mid-height right → 0.5 top → 0.75 mid-height left).
 */
export function buildSkin(profile: LoftProfile, opts: SkinOptions): SkinResult {
  const keep = opts.keep ?? [];
  const radial = opts.radial ?? 72;
  const offset = opts.offset ?? 0;
  const inside = opts.inside ?? false;
  const rows = Math.max(1, Math.ceil((opts.z1 - opts.z0) / (opts.dz ?? 0.05)));
  const u0 = opts.uRange ? opts.uRange[0] : profile.zMin;
  const uLen = (opts.uRange ? opts.uRange[1] : profile.zMax) - u0 || 1;
  const sec: LoftStation = { z: 0, width: 0, height: 0, yCenter: 0, n: 2 };
  const p = new THREE.Vector3(), nrm = new THREE.Vector3();
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  const rib: number[] = [], ribN: number[] = [];
  const revealSet = new Set(opts.reveal?.constraints ?? []);

  const evalG = (z: number, t: number): number[] => {
    profile.pointAt(z, t, p);
    return keep.map((c) => c(p.x, p.y, p.z));
  };
  const gOne = (ci: number, z: number, t: number): number => {
    profile.pointAt(z, t, p);
    return keep[ci](p.x, p.y, p.z);
  };
  const surf = (z: number, t: number, off: number, outP: THREE.Vector3, outN: THREE.Vector3): void => {
    profile.pointAt(z, t, outP);
    profile.normalAt(z, t, outN);
    outP.addScaledVector(outN, off);
  };
  const vOf = (z: number, t: number): number => {
    profile.sectionAt(z, sec);
    profile.pointAt(z, t, p, sec);
    const frac = Math.max(0, Math.min(1, (p.y - (sec.yCenter - sec.height / 2)) / sec.height));
    const tt = ((t % TWO_PI) + TWO_PI) % TWO_PI;
    return tt <= Math.PI ? 0.5 * frac : 1 - 0.5 * frac;
  };
  const vtx = new THREE.Vector3(), vn = new THREE.Vector3();
  const emitVertex = (q: PT): void => {
    surf(q.z, q.t, offset, vtx, vn);
    pos.push(vtx.x, vtx.y, vtx.z);
    const s = inside ? -1 : 1;
    nor.push(vn.x * s, vn.y * s, vn.z * s);
    uv.push((q.z - u0) / uLen, vOf(q.z, q.t));
  };
  const emitPoly = (poly: PT[]): void => {
    for (let k = 1; k < poly.length - 1; k++) {
      // outward faces are clockwise in (z, t); the polygons are counter-clockwise
      if (inside) { emitVertex(poly[0]); emitVertex(poly[k]); emitVertex(poly[k + 1]); }
      else { emitVertex(poly[0]); emitVertex(poly[k + 1]); emitVertex(poly[k]); }
    }
  };
  const crossing = (ci: number, a: PT, b: PT): PT => {
    let lo = 0, hi = 1;
    const sa = a.g[ci] >= 0;
    for (let it = 0; it < 12; it++) {
      const m = (lo + hi) / 2;
      const v = gOne(ci, a.z + (b.z - a.z) * m, a.t + (b.t - a.t) * m);
      if ((v >= 0) === sa) lo = m; else hi = m;
    }
    const s = (lo + hi) / 2;
    const z = a.z + (b.z - a.z) * s, t = a.t + (b.t - a.t) * s;
    const g = evalG(z, t);
    g[ci] = 0;
    return { z, t, g };
  };
  const a3 = new THREE.Vector3(), b3 = new THREE.Vector3(), a4 = new THREE.Vector3(), b4 = new THREE.Vector3();
  const na = new THREE.Vector3(), nb = new THREE.Vector3(), d3 = new THREE.Vector3(), rn = new THREE.Vector3();
  const addRibbon = (a: PT, b: PT): void => {
    // in (z, t) the kept skin is left of a→b; seen from outside the cut-out is left of a→b
    const to = opts.reveal!.to;
    surf(a.z, a.t, offset, a3, na); surf(b.z, b.t, offset, b3, nb);
    surf(a.z, a.t, to, a4, na); surf(b.z, b.t, to, b4, nb);
    d3.subVectors(b3, a3);
    if (d3.lengthSq() < 1e-12) return;
    rn.crossVectors(na.add(nb).normalize(), d3).normalize(); // N × D: toward the cut-out
    for (const v of [a3, b4, b3, a3, a4, b4]) { rib.push(v.x, v.y, v.z); ribN.push(rn.x, rn.y, rn.z); }
  };

  // grid
  const grid: PT[][] = [];
  for (let i = 0; i <= rows; i++) {
    const z = opts.z0 + ((opts.z1 - opts.z0) * i) / rows;
    const row: PT[] = [];
    for (let j = 0; j <= radial; j++) {
      const t = (TWO_PI * j) / radial;
      row.push({ z, t, g: evalG(z, t) });
    }
    grid.push(row);
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < radial; j++) {
      let poly: PT[] = [grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]];
      for (let ci = 0; ci < keep.length && poly.length >= 3; ci++) {
        let allIn = true, allOut = true;
        for (const q of poly) { if (q.g[ci] >= 0) allOut = false; else allIn = false; }
        if (allIn) continue;
        if (allOut) { poly = []; break; }
        const out: PT[] = [];
        const cut: PT[] = [];
        for (let k = 0; k < poly.length; k++) {
          const a = poly[k], b = poly[(k + 1) % poly.length];
          if (a.g[ci] >= 0) out.push(a);
          if ((a.g[ci] >= 0) !== (b.g[ci] >= 0)) { const c = crossing(ci, a, b); out.push(c); cut.push(c); }
        }
        if (revealSet.has(ci) && cut.length === 2) {
          // order the cut edge as it appears in the (counter-clockwise) kept polygon
          const i0 = out.indexOf(cut[0]), i1 = out.indexOf(cut[1]);
          if ((i0 + 1) % out.length === i1) addRibbon(cut[0], cut[1]); else addRibbon(cut[1], cut[0]);
        }
        poly = out;
      }
      if (poly.length >= 3) emitPoly(poly);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const reveal = new THREE.BufferGeometry();
  reveal.setAttribute('position', new THREE.Float32BufferAttribute(rib, 3));
  reveal.setAttribute('normal', new THREE.Float32BufferAttribute(ribN, 3));
  return { geometry, reveal };
}

/** Constraint helpers. */
export const inside = (f: SkinField): Constraint => (x, y, z) => -f(x, y, z);
export const outside = (f: SkinField): Constraint => f;
/** keep the band −w ≤ f ≤ +w (seam lines) */
export const band = (f: SkinField, w: number): Constraint[] => [(x, y, z) => f(x, y, z) + w, (x, y, z) => w - f(x, y, z)];
/** keep the inner band −w ≤ f ≤ 0 (frame just inside an outline) */
export const innerBand = (f: SkinField, w: number): Constraint[] => [(x, y, z) => -f(x, y, z), (x, y, z) => f(x, y, z) + w];
