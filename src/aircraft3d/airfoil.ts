/**
 * Airfoil sections and lifting-surface lofts (wings, stabilisers, fin, struts, prop blades).
 *
 * A {@link WingSection} describes one spanwise station in the *wing-local* frame:
 * span axis +X (outboard), chord axis +Z (aft, leading edge at `le`), thickness +Y.
 * {@link buildWingPanel} lofts a NACA 4-digit-like polygon through the sections (smooth
 * shaded, optional twist) and caps the ends. Control surfaces are built as the aft part
 * of the same polygon ({@link buildWingPanel} with `chordFrom`/`chordTo`).
 */
import * as THREE from 'three';

export interface AirfoilSpec {
  /** max thickness as fraction of chord (0.12 for NACA 2412) */
  thickness: number;
  /** max camber fraction (0.02 for NACA 2412, 0 for symmetric) */
  camber: number;
  /** position of max camber (0.4 for NACA 2412) */
  camberPos: number;
}

export const NACA2412: AirfoilSpec = { thickness: 0.12, camber: 0.02, camberPos: 0.4 };
export const NACA0012: AirfoilSpec = { thickness: 0.12, camber: 0, camberPos: 0.4 };
export const NACA0009: AirfoilSpec = { thickness: 0.09, camber: 0, camberPos: 0.4 };

/**
 * Closed airfoil polygon (counter-clockwise seen from +X, i.e. from the wing tip looking
 * inboard) for a unit chord, as [zFraction, yFraction] pairs. `from`/`to` crop the chord
 * (0..1) so that a control surface (e.g. from = 0.75) or a truncated main panel (to = 0.75)
 * can be built; cropped edges are closed with a straight segment.
 */
export function airfoilPolygon(spec: AirfoilSpec, points = 14, from = 0, to = 1): Array<[number, number]> {
  const thick = (x: number) => 5 * spec.thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const camb = (x: number) => {
    const m = spec.camber, p = spec.camberPos;
    if (m === 0) return 0;
    return x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x - x * x);
  };
  const upper: Array<[number, number]> = [];
  const lower: Array<[number, number]> = [];
  for (let i = 0; i <= points; i++) {
    // cosine spacing for a rounder leading edge
    const s = 0.5 - 0.5 * Math.cos((Math.PI * i) / points);
    const x = from + (to - from) * s;
    const yc = camb(x), yt = thick(x);
    upper.push([x, yc + yt]);
    lower.push([x, yc - yt]);
  }
  // Polygon: from trailing edge along the upper surface to the LE, back along the lower surface.
  const poly: Array<[number, number]> = [];
  for (let i = points; i >= 0; i--) poly.push(upper[i]);
  for (let i = 1; i <= points; i++) poly.push(lower[i]);
  // If the trailing end is cropped (to < 1) the last/first points differ -> closed by the strip wrap.
  return poly;
}

export interface WingSection {
  /** spanwise position along +X (m) */
  x: number;
  /** chord length (m) */
  chord: number;
  /** leading-edge position (z, aft positive) and height (y) of the chord line */
  le: THREE.Vector3Like;
  /** geometric twist about the quarter chord, rad, positive = leading edge up */
  twist?: number;
}

export interface WingPanelOptions {
  airfoil: AirfoilSpec;
  sections: WingSection[];
  /** crop chord fractions (default 0..1) */
  chordFrom?: number;
  chordTo?: number;
  /** points per surface in the airfoil polygon (default 14) */
  points?: number;
  /** cap the inboard / outboard ends (default both) */
  capRoot?: boolean;
  capTip?: boolean;
  /** span subdivisions between sections (default 1) */
  spanSubdivisions?: number;
}

/**
 * Loft an airfoil polygon through spanwise sections. Returns a smooth-shaded indexed geometry
 * in the wing-local frame (span +X, chord +Z aft, thickness +Y).
 */
export function buildWingPanel(opts: WingPanelOptions): THREE.BufferGeometry {
  const from = opts.chordFrom ?? 0, to = opts.chordTo ?? 1;
  const poly = airfoilPolygon(opts.airfoil, opts.points ?? 14, from, to);
  const m = poly.length;
  const secs = opts.sections;
  const sub = Math.max(1, opts.spanSubdivisions ?? 1);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // Expand sections with subdivisions (linear)
  const rings: WingSection[] = [];
  for (let i = 0; i < secs.length - 1; i++) {
    const a = secs[i], b = secs[i + 1];
    for (let k = 0; k < sub; k++) {
      const f = k / sub;
      rings.push({
        x: a.x + (b.x - a.x) * f,
        chord: a.chord + (b.chord - a.chord) * f,
        le: { x: 0, y: a.le.y + (b.le.y - a.le.y) * f, z: a.le.z + (b.le.z - a.le.z) * f },
        twist: (a.twist ?? 0) + ((b.twist ?? 0) - (a.twist ?? 0)) * f,
      });
    }
  }
  rings.push(secs[secs.length - 1]);

  for (let r = 0; r < rings.length; r++) {
    const s = rings[r];
    const tw = s.twist ?? 0, ct = Math.cos(tw), stw = Math.sin(tw);
    for (let j = 0; j < m; j++) {
      const [zf, yf] = poly[j];
      // local chord coords relative to quarter chord for twist
      const zc = (zf - 0.25) * s.chord, yc = yf * s.chord;
      // twist: positive = LE up => rotate about +X by -tw (z aft)
      const z = zc * ct + yc * stw;
      const y = -zc * stw + yc * ct;
      positions.push(s.x, s.le.y + y, s.le.z + 0.25 * s.chord + z);
      uvs.push(j / (m - 1), r / (rings.length - 1));
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let j = 0; j < m; j++) {
      const j1 = (j + 1) % m;
      const a = r * m + j, b = r * m + j1, c = (r + 1) * m + j, d = (r + 1) * m + j1;
      // polygon runs TE→upper→LE→lower→TE; outward winding:
      indices.push(a, c, b, b, c, d);
    }
  }
  const addCap = (ring: number, outward: boolean) => {
    const s = rings[ring];
    const ci = positions.length / 3;
    positions.push(s.x, s.le.y, s.le.z + 0.5 * s.chord * (from + to));
    uvs.push(0.5, ring === 0 ? 0 : 1);
    for (let j = 0; j < m; j++) {
      const a = ring * m + j, b = ring * m + ((j + 1) % m);
      if (outward) indices.push(ci, b, a); else indices.push(ci, a, b);
    }
  };
  if (opts.capRoot ?? true) addCap(0, false);
  if (opts.capTip ?? true) addCap(rings.length - 1, true);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/**
 * Convenience: chord-line point of a linearly interpolated planform at span position x and
 * chord fraction f (for hinge lines). Sections must be sorted by x ascending.
 */
export function planformPoint(sections: WingSection[], x: number, f: number, out: THREE.Vector3): THREE.Vector3 {
  let i = 0;
  while (i < sections.length - 2 && sections[i + 1].x < x) i++;
  const a = sections[i], b = sections[i + 1];
  const k = (x - a.x) / (b.x - a.x || 1);
  const chord = a.chord + (b.chord - a.chord) * k;
  const ley = a.le.y + (b.le.y - a.le.y) * k;
  const lez = a.le.z + (b.le.z - a.le.z) * k;
  return out.set(x, ley, lez + chord * f);
}
