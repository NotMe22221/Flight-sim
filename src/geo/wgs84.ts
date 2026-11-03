/**
 * WGS84 geodesy: geodetic ↔ ECEF ↔ local tangent frames.
 *
 * The simulator's physics frame is a local NED tangent plane anchored at a floating
 * origin. The render frame is (x = East, y = Up, z = South). Both are produced here from
 * the same ECEF math so that curvature, horizon dip and GPS geometry are all consistent.
 */
import type { Geodetic, LocalFrameInfo, Vec3 } from '../core/types';

export const WGS84_A = 6378137;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_B = WGS84_A * (1 - WGS84_F);
export const WGS84_E2 = WGS84_F * (2 - WGS84_F); // 6.69437999014e-3
/** Mean earth radius (m), used for horizon/curvature estimates only. */
export const EARTH_RADIUS = 6371000;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
/** ECEF scratch for the *ToGeodetic conversions (called every physics step; all synchronous). */
const ECEF_SCRATCH: Vec3 = [0, 0, 0];

export type Ecef = Vec3;

export function geodeticToEcef(latDeg: number, lonDeg: number, h: number, out: Vec3 = [0, 0, 0]): Ecef {
  const lat = latDeg * D2R, lon = lonDeg * D2R;
  const s = Math.sin(lat), c = Math.cos(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
  out[0] = (N + h) * c * Math.cos(lon);
  out[1] = (N + h) * c * Math.sin(lon);
  out[2] = (N * (1 - WGS84_E2) + h) * s;
  return out;
}

/** ECEF → geodetic (degrees, metres). Iterative Bowring-style solution; converges to < 1e-9 rad in 3 iterations. */
export function ecefToGeodetic(x: number, y: number, z: number, out: Geodetic = { lat: 0, lon: 0, alt: 0 }): Geodetic {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  if (p < 1e-9) {
    // On the polar axis
    out.lat = z >= 0 ? 90 : -90;
    out.lon = 0;
    out.alt = Math.abs(z) - WGS84_B;
    return out;
  }
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  let N = WGS84_A, h = 0;
  for (let i = 0; i < 5; i++) {
    const s = Math.sin(lat);
    N = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
    h = p / Math.cos(lat) - N;
    const latNew = Math.atan2(z, p * (1 - WGS84_E2 * N / (N + h)));
    if (Math.abs(latNew - lat) < 1e-12) { lat = latNew; break; }
    lat = latNew;
  }
  out.lat = lat * R2D;
  out.lon = lon * R2D;
  out.alt = h;
  return out;
}

/**
 * A local tangent frame at (lat0, lon0, alt0). Provides NED (physics) and Three.js (render)
 * coordinates from the same rotation. All math in float64.
 */
export class LocalFrame implements LocalFrameInfo {
  readonly origin: Ecef;
  /** rows: East, North, Up unit vectors expressed in ECEF */
  readonly east: Vec3;
  readonly north: Vec3;
  readonly up: Vec3;

  constructor(public readonly lat0: number, public readonly lon0: number, public readonly alt0: number) {
    this.origin = geodeticToEcef(lat0, lon0, alt0);
    const la = lat0 * D2R, lo = lon0 * D2R;
    const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
    this.east = [-so, co, 0];
    this.north = [-sl * co, -sl * so, cl];
    this.up = [cl * co, cl * so, sl];
  }

  get info(): LocalFrameInfo { return { lat0: this.lat0, lon0: this.lon0, alt0: this.alt0 }; }

  /** ECEF → local NED (north, east, down). */
  ecefToNED(p: Ecef, out: Vec3 = [0, 0, 0]): Vec3 {
    const dx = p[0] - this.origin[0], dy = p[1] - this.origin[1], dz = p[2] - this.origin[2];
    const e = this.east[0] * dx + this.east[1] * dy + this.east[2] * dz;
    const n = this.north[0] * dx + this.north[1] * dy + this.north[2] * dz;
    const u = this.up[0] * dx + this.up[1] * dy + this.up[2] * dz;
    out[0] = n; out[1] = e; out[2] = -u;
    return out;
  }

  /** local NED → ECEF. */
  nedToEcef(n: number, e: number, d: number, out: Vec3 = [0, 0, 0]): Ecef {
    const u = -d;
    out[0] = this.origin[0] + this.east[0] * e + this.north[0] * n + this.up[0] * u;
    out[1] = this.origin[1] + this.east[1] * e + this.north[1] * n + this.up[1] * u;
    out[2] = this.origin[2] + this.east[2] * e + this.north[2] * n + this.up[2] * u;
    return out;
  }

  /** geodetic → local NED (exact, includes curvature). */
  geodeticToNED(lat: number, lon: number, alt: number, out: Vec3 = [0, 0, 0]): Vec3 {
    return this.ecefToNED(geodeticToEcef(lat, lon, alt, out), out);
  }

  /** local NED → geodetic (exact). Allocation-free when `out` is passed. */
  nedToGeodetic(n: number, e: number, d: number, out: Geodetic = { lat: 0, lon: 0, alt: 0 }): Geodetic {
    const p = this.nedToEcef(n, e, d, ECEF_SCRATCH);
    return ecefToGeodetic(p[0], p[1], p[2], out);
  }

  /** ECEF → Three.js render coords (x East, y Up, z South). */
  ecefToThree(p: Ecef, out: Vec3 = [0, 0, 0]): Vec3 {
    this.ecefToNED(p, out);
    const n = out[0], e = out[1], d = out[2];
    out[0] = e; out[1] = -d; out[2] = -n;
    return out;
  }

  geodeticToThree(lat: number, lon: number, alt: number, out: Vec3 = [0, 0, 0]): Vec3 {
    return this.ecefToThree(geodeticToEcef(lat, lon, alt, out), out);
  }

  /** Three.js render coords → ECEF. */
  threeToEcef(x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Ecef {
    return this.nedToEcef(-z, x, -y, out);
  }

  /** Three.js render coords → geodetic. Allocation-free when `out` is passed. */
  threeToGeodetic(x: number, y: number, z: number, out: Geodetic = { lat: 0, lon: 0, alt: 0 }): Geodetic {
    const p = this.threeToEcef(x, y, z, ECEF_SCRATCH);
    return ecefToGeodetic(p[0], p[1], p[2], out);
  }

  /**
   * Rotation matrix (row-major 3x3) that maps a vector expressed in THIS frame's NED axes
   * into `other` frame's NED axes. Used when rebasing the floating origin.
   */
  rotationNEDTo(other: LocalFrame): [number, number, number, number, number, number, number, number, number] {
    // Columns of this frame's NED basis in ECEF: N=this.north, E=this.east, D=-this.up.
    // Rows of other's NED basis: other.north, other.east, -other.up. R_ij = other_i · this_j
    const tN = this.north, tE = this.east, tD: Vec3 = [-this.up[0], -this.up[1], -this.up[2]];
    const oN = other.north, oE = other.east, oD: Vec3 = [-other.up[0], -other.up[1], -other.up[2]];
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return [
      dot(oN, tN), dot(oN, tE), dot(oN, tD),
      dot(oE, tN), dot(oE, tE), dot(oE, tD),
      dot(oD, tN), dot(oD, tE), dot(oD, tD),
    ];
  }
}

/** Convert NED vector to Three.js (x E, y U, z S). */
export const nedToThree = (v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 => {
  const n = v[0], e = v[1], d = v[2];
  out[0] = e; out[1] = -d; out[2] = -n;
  return out;
};
/** Convert Three.js vector to NED. */
export const threeToNED = (v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 => {
  const x = v[0], y = v[1], z = v[2];
  out[0] = -z; out[1] = x; out[2] = -y;
  return out;
};

/** Great-circle distance (m) on the sphere — adequate for nav displays. */
export function greatCircleDistance(a: Geodetic, b: Geodetic): number {
  const φ1 = a.lat * D2R, φ2 = b.lat * D2R;
  const dφ = (b.lat - a.lat) * D2R, dλ = (b.lon - a.lon) * D2R;
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** Initial true bearing (deg, 0..360) from a to b. */
export function initialBearingDeg(a: Geodetic, b: Geodetic): number {
  const φ1 = a.lat * D2R, φ2 = b.lat * D2R, dλ = (b.lon - a.lon) * D2R;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  const θ = Math.atan2(y, x) * R2D;
  return (θ + 360) % 360;
}

/** Destination point given start, true bearing (deg) and distance (m) on the sphere. */
export function destinationPoint(a: Geodetic, bearingDeg: number, distanceM: number, alt = a.alt): Geodetic {
  const δ = distanceM / EARTH_RADIUS, θ = bearingDeg * D2R;
  const φ1 = a.lat * D2R, λ1 = a.lon * D2R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: φ2 * R2D, lon: ((λ2 * R2D + 540) % 360) - 180, alt };
}

/** Geometric horizon distance (m) for an eye height h (m). */
export const horizonDistance = (h: number): number => Math.sqrt(2 * EARTH_RADIUS * Math.max(h, 0));
/** Horizon dip angle (rad) below local horizontal. */
export const horizonDip = (h: number): number => Math.acos(EARTH_RADIUS / (EARTH_RADIUS + Math.max(h, 0)));
