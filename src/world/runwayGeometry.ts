/**
 * Pure runway geometry in the render frame (x East, y Up, z South) for a given LocalFrame.
 * Used by the 3D airports layer and by tests. No Three.js here.
 */
import { wrap360 } from '../core/math';
import type { Geodetic, Runway, Vec3 } from '../core/types';
import { LocalFrame } from '../geo/wgs84';
import { runwayEndDisplacementB, runwayEndIdents } from './runwayIdents';

export interface RunwayEndGeometry {
  ident: string;
  /** threshold (pavement end) position, render frame */
  pos: Vec3;
  /** displaced threshold position (where landing markings start), render frame */
  displacedPos: Vec3;
  /** unit vector pointing down the runway from this end toward the other, render frame (horizontal) */
  dir: Vec3;
  /** true heading of this end in degrees (direction of travel when departing from it) */
  headingDeg: number;
  displacedM: number;
  elevationM: number;
}

export interface RunwayGeometry {
  ident: string;
  lengthM: number;
  widthM: number;
  /** [A, B] where A corresponds to Runway.threshold / end order in the data */
  ends: [RunwayEndGeometry, RunwayEndGeometry];
  /** centre of the pavement, render frame */
  center: Vec3;
  /** unit along-runway vector from A to B (horizontal), render frame */
  along: Vec3;
  /** unit across vector (right of `along` when looking from A to B), render frame */
  across: Vec3;
  /** corners in order: A-left, A-right, B-right, B-left (looking from A toward B) */
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** slope along the runway (rise/run) */
  slope: number;
}

/** Light position lists for one runway. */
export interface RunwayLights {
  edgeWhite: Vec3[];
  /** green when viewed on approach, red from the runway: one set per end; we colour by end */
  thresholdA: Vec3[];
  thresholdB: Vec3[];
  /** PAPI for approaches to each end: 4 units left of the runway, 300 m past the threshold */
  papiA: Vec3[];
  papiB: Vec3[];
}

const horizontalUnit = (from: Vec3, to: Vec3, out: Vec3 = [0, 0, 0]): Vec3 => {
  const dx = to[0] - from[0], dz = to[2] - from[2];
  const l = Math.hypot(dx, dz) || 1;
  out[0] = dx / l; out[1] = 0; out[2] = dz / l;
  return out;
};

/** True heading (deg) of a horizontal render-frame direction: x East, z South. */
export const headingOfDir = (d: Vec3): number => wrap360((Math.atan2(d[0], -d[2]) * 180) / Math.PI);

const geoToThree = (frame: LocalFrame, g: Geodetic, altOverride?: number): Vec3 =>
  frame.geodeticToThree(g.lat, g.lon, altOverride ?? g.alt);

export function runwayGeometry(rw: Runway, frame: LocalFrame, surfaceLift = 0.12): RunwayGeometry {
  const a = geoToThree(frame, rw.threshold);
  const b = geoToThree(frame, rw.end);
  a[1] += surfaceLift; b[1] += surfaceLift;
  const along = horizontalUnit(a, b);
  const across: Vec3 = [-along[2], 0, along[0]]; // rotate 90° clockwise seen from above (right of travel)
  const horiz = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const lengthM = rw.lengthM > 0 ? rw.lengthM : horiz;
  const halfW = rw.widthM / 2;
  const dispA = rw.displacedThresholdM || 0;
  const dispB = runwayEndDisplacementB(rw);
  const [identA, identB] = runwayEndIdents(rw);
  const endA: RunwayEndGeometry = {
    ident: identA,
    pos: a,
    displacedPos: [a[0] + along[0] * dispA, a[1] + ((b[1] - a[1]) * dispA) / Math.max(horiz, 1), a[2] + along[2] * dispA],
    dir: along,
    headingDeg: headingOfDir(along),
    displacedM: dispA,
    elevationM: rw.threshold.alt,
  };
  const back: Vec3 = [-along[0], 0, -along[2]];
  const endB: RunwayEndGeometry = {
    ident: identB,
    pos: b,
    displacedPos: [b[0] + back[0] * dispB, b[1] + ((a[1] - b[1]) * dispB) / Math.max(horiz, 1), b[2] + back[2] * dispB],
    dir: back,
    headingDeg: headingOfDir(back),
    displacedM: dispB,
    elevationM: rw.end.alt,
  };
  const corners: [Vec3, Vec3, Vec3, Vec3] = [
    [a[0] - across[0] * halfW, a[1], a[2] - across[2] * halfW],
    [a[0] + across[0] * halfW, a[1], a[2] + across[2] * halfW],
    [b[0] + across[0] * halfW, b[1], b[2] + across[2] * halfW],
    [b[0] - across[0] * halfW, b[1], b[2] - across[2] * halfW],
  ];
  return {
    ident: rw.ident,
    lengthM,
    widthM: rw.widthM,
    ends: [endA, endB],
    center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    along,
    across,
    corners,
    slope: horiz > 0 ? (b[1] - a[1]) / horiz : 0,
  };
}

/** Standard-ish GA lighting layout. Spacing 60 m edge lights, 8 threshold lights per end, 4-box PAPI. */
export function runwayLights(g: RunwayGeometry, edgeSpacingM = 60): RunwayLights {
  const [A, B] = g.ends;
  const a = A.pos, b = B.pos;
  const horiz = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const halfW = g.widthM / 2 + 1.5;
  const edgeWhite: Vec3[] = [];
  const n = Math.max(2, Math.floor(horiz / edgeSpacingM));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t + 0.4, pz = a[2] + (b[2] - a[2]) * t;
    edgeWhite.push([px - g.across[0] * halfW, py, pz - g.across[2] * halfW]);
    edgeWhite.push([px + g.across[0] * halfW, py, pz + g.across[2] * halfW]);
  }
  const thresholdRow = (end: RunwayEndGeometry): Vec3[] => {
    const row: Vec3[] = [];
    const p = end.displacedPos;
    const count = 8;
    for (let i = 0; i < count; i++) {
      const s = (i / (count - 1) - 0.5) * (g.widthM - 2);
      row.push([p[0] + g.across[0] * s, p[1] + 0.3, p[2] + g.across[2] * s]);
    }
    return row;
  };
  const papi = (end: RunwayEndGeometry): Vec3[] => {
    // 4 boxes, 300 m past the threshold, 15 m left of the edge (left when approaching = -across for end A travelling along `dir`)
    const left: Vec3 = [-(-end.dir[2]), 0, -end.dir[0]]; // right-of-dir rotated: right = (-dir.z, 0, dir.x) → left = negative
    const base: Vec3 = [
      end.displacedPos[0] + end.dir[0] * 300 + left[0] * (g.widthM / 2 + 15),
      end.displacedPos[1] + g.slope * (end === g.ends[0] ? 300 : -300) + 0.5,
      end.displacedPos[2] + end.dir[2] * 300 + left[2] * (g.widthM / 2 + 15),
    ];
    const out: Vec3[] = [];
    for (let i = 0; i < 4; i++) out.push([base[0] + left[0] * 9 * i, base[1], base[2] + left[2] * 9 * i]);
    return out;
  };
  return { edgeWhite, thresholdA: thresholdRow(A), thresholdB: thresholdRow(B), papiA: papi(A), papiB: papi(B) };
}

/**
 * PAPI indication for an observer: returns 4 booleans (true = white) for boxes ordered from the
 * runway outward. Standard angles 3°30', 3°10', 2°50', 2°30' (white when observer above the angle).
 */
export function papiIndication(observer: Vec3, papiBase: Vec3, glideDeg = 3): [boolean, boolean, boolean, boolean] {
  const dx = observer[0] - papiBase[0], dz = observer[2] - papiBase[2], dy = observer[1] - papiBase[1];
  const horiz = Math.hypot(dx, dz);
  const angle = (Math.atan2(dy, Math.max(horiz, 1)) * 180) / Math.PI;
  const offsets = [0.5, 0.1667, -0.1667, -0.5];
  return [angle > glideDeg + offsets[0], angle > glideDeg + offsets[1], angle > glideDeg + offsets[2], angle > glideDeg + offsets[3]];
}

/** Night lighting beyond edge/threshold/PAPI: REIL, centreline and approach lighting. */
export interface ApproachLights {
  /** runway end identifier lights: pairs of strobes either side of each threshold */
  reilA: Vec3[];
  reilB: Vec3[];
  /** white centreline lights every 15 m (long runways) */
  centreline: Vec3[];
  /** steady approach light bars before each threshold (MALSR-style) */
  barsA: Vec3[];
  barsB: Vec3[];
  /** sequenced flasher positions, ordered from the far end toward the threshold */
  rabbitA: Vec3[];
  rabbitB: Vec3[];
}

export interface ApproachLightOptions {
  /** build approach bars + sequenced flashers for this end */
  alsA: boolean;
  alsB: boolean;
  centreline: boolean;
}

/**
 * MALSR-like approach lighting (simplified): 5-light bars every 60 m out to 720 m before the
 * (displaced) threshold, a wide crossbar at 300 m, and sequenced flashers on the outer 360 m;
 * REIL strobes 12 m outside each runway edge at the threshold; centreline lights every 15 m.
 * All points sit at the threshold elevation (approach lights over water stand on piers).
 */
export function approachLights(g: RunwayGeometry, opt: ApproachLightOptions): ApproachLights {
  const [A, B] = g.ends;
  const across = g.across;
  const reil = (end: RunwayEndGeometry): Vec3[] => {
    const p = end.displacedPos;
    const off = g.widthM / 2 + 12;
    return [
      [p[0] - across[0] * off, p[1] + 0.6, p[2] - across[2] * off],
      [p[0] + across[0] * off, p[1] + 0.6, p[2] + across[2] * off],
    ];
  };
  const als = (end: RunwayEndGeometry): { bars: Vec3[]; rabbit: Vec3[] } => {
    const bars: Vec3[] = [], rabbit: Vec3[] = [];
    const p = end.displacedPos, d = end.dir; // d points down the runway from this end
    for (let dist = 60; dist <= 720; dist += 60) {
      const cx = p[0] - d[0] * dist, cy = p[1] + 0.5, cz = p[2] - d[2] * dist;
      const half = dist === 300 ? 15 : 2.1;
      const n = dist === 300 ? 11 : 5;
      for (let i = 0; i < n; i++) {
        const s = -half + (2 * half * i) / (n - 1);
        bars.push([cx + across[0] * s, cy, cz + across[2] * s]);
      }
    }
    for (let dist = 720; dist >= 420; dist -= 60) rabbit.push([p[0] - d[0] * dist, p[1] + 1.0, p[2] - d[2] * dist]);
    return { bars, rabbit };
  };
  const centre: Vec3[] = [];
  if (opt.centreline) {
    const a = A.displacedPos, b = B.displacedPos;
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const n = Math.floor(len / 15);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      centre.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + 0.15, a[2] + (b[2] - a[2]) * t]);
    }
  }
  const sa = opt.alsA ? als(A) : { bars: [], rabbit: [] };
  const sb = opt.alsB ? als(B) : { bars: [], rabbit: [] };
  return { reilA: reil(A), reilB: reil(B), centreline: centre, barsA: sa.bars, barsB: sb.bars, rabbitA: sa.rabbit, rabbitB: sb.rabbit };
}
