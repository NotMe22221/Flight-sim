/**
 * Aircraft position relative to a runway end, traffic-pattern leg classification for left and
 * right traffic, "established on final" detection and pattern-entry choice. Pure functions,
 * allocation-free when an `out` object is passed (call every frame).
 *
 * Runway frame: `alongM` is measured from the pavement threshold along the landing direction
 * (negative = on the approach side), `crossM` is + right of the centreline looking along the
 * landing direction, `heightM` is above the threshold elevation, `relTrackDeg` is the ground
 * track minus the runway heading in (−180, 180].
 */
import type { Airport, Geodetic } from '../core/types';
import { deltaDeg } from '../core/math';
import { NM } from '../core/units';
import { relativeToRunway, type RunwayEndRef, type RunwayRelative } from '../activities/runwayFrame';
import { greatCircleDistance, initialBearingDeg } from '../geo/wgs84';
import type { RunwayRef } from './field';

/** Traffic pattern direction (turns toward this side). */
export type TrafficSide = 'left' | 'right';
/** Traffic-pattern legs (AC 90-66C), or 'outside' the pattern. */
export type PatternLeg = 'upwind' | 'crosswind' | 'downwind' | 'base' | 'final' | 'outside';
/** How a tower tells an arrival to join the pattern. */
export type PatternEntry = 'straight-in' | 'base' | 'downwind';

/** A runway end prepared for per-frame relative-position queries. */
export interface RunwayFrame {
  readonly ref: RunwayRef;
  /** reference for `activities/runwayFrame.relativeToRunway` */
  readonly endRef: RunwayEndRef;
  readonly ident: string;
  readonly headingDeg: number;
  readonly lengthM: number;
  readonly widthM: number;
  /** threshold elevation, m MSL */
  readonly elevationM: number;
}

/** Aircraft position in a runway frame. */
export interface RunwayRelativeState {
  alongM: number;
  crossM: number;
  heightM: number;
  relTrackDeg: number;
}

/** Build a runway frame for a runway end of an airport. */
export function makeRunwayFrame(airport: Airport, r: RunwayRef): RunwayFrame {
  const endRef: RunwayEndRef = {
    airport, runway: r.runway, ident: r.ident, threshold: r.threshold, headingDeg: r.headingDeg,
    lengthM: r.lengthM, widthM: r.widthM, displacedM: r.end.displacedThresholdM,
  };
  const elev = Number.isFinite(r.threshold.alt) && r.threshold.alt !== 0 ? r.threshold.alt : airport.elevationM;
  return { ref: r, endRef, ident: r.ident, headingDeg: r.headingDeg, lengthM: r.lengthM, widthM: r.widthM, elevationM: elev };
}

/** Empty relative state for reuse. */
export const makeRelativeState = (): RunwayRelativeState => ({ alongM: 0, crossM: 0, heightM: 0, relTrackDeg: 0 });

const scratch: RunwayRelative = { alongM: 0, crossM: 0 };

/** Aircraft (geodetic position, MSL altitude, true ground track) relative to a runway frame. */
export function relativeTo(frame: RunwayFrame, pos: Geodetic, altMslM: number, trackDeg: number, out: RunwayRelativeState = makeRelativeState()): RunwayRelativeState {
  relativeToRunway(pos, frame.endRef, scratch);
  out.alongM = scratch.alongM;
  out.crossM = scratch.crossM;
  out.heightM = altMslM - frame.elevationM;
  out.relTrackDeg = deltaDeg(trackDeg, frame.headingDeg);
  return out;
}

/** Pattern classification limits. */
export const PATTERN_LIMITS = {
  /** farthest lateral distance still in the pattern, m */
  maxLateralM: 2.5 * NM,
  /** farthest distance on final (approach side), m */
  maxFinalM: 5 * NM,
  /** farthest distance beyond the departure end, m */
  maxBeyondEndM: 2.5 * NM,
  /** highest height above the field, m (≈ 3 000 ft) */
  maxHeightM: 915,
  /** half-width of the extended-centreline corridor near the runway, m */
  centrelineM: 300,
  /** corridor widening on final, m per m from the threshold (≈ 8.5°) */
  centrelineSlope: 0.15,
  /** least lateral spacing of a downwind leg, m */
  downwindMinLateralM: 300,
  /** track tolerance for aligned legs, deg */
  alignedDeg: 45,
  /** track tolerance for the downwind (reciprocal ± this), deg */
  downwindDeg: 60,
} as const;

/**
 * Classify the pattern leg from position and track. `side` is the traffic direction for this
 * runway. Upwind and final are on the extended centreline (past / before the threshold);
 * crosswind and base are perpendicular legs heading away from / back toward the centreline on
 * the pattern side; downwind is the reciprocal track on the pattern side.
 */
export function classifyPatternLeg(rel: RunwayRelativeState, runwayLengthM: number, side: TrafficSide): PatternLeg {
  const L = PATTERN_LIMITS;
  if (rel.heightM > L.maxHeightM || Math.abs(rel.crossM) > L.maxLateralM) return 'outside';
  if (rel.alongM < -L.maxFinalM || rel.alongM > runwayLengthM + L.maxBeyondEndM) return 'outside';
  const ps = side === 'left' ? -1 : 1;
  const lat = rel.crossM * ps; // + = on the pattern side
  const m = rel.relTrackDeg * ps; // +90 = turning out toward the pattern side, −90 = back toward the centreline
  const absRt = Math.abs(rel.relTrackDeg);
  const corridor = L.centrelineM + L.centrelineSlope * Math.max(0, -rel.alongM);
  if (absRt <= L.alignedDeg && Math.abs(rel.crossM) <= corridor) return rel.alongM < 0 ? 'final' : 'upwind';
  if (absRt <= L.alignedDeg && rel.alongM >= 0 && lat < 2 * L.centrelineM) return 'upwind';
  if (absRt >= 180 - L.downwindDeg && lat >= L.downwindMinLateralM) return 'downwind';
  if (m >= 30 && m <= 150 && rel.alongM > 0 && lat > -L.centrelineM) return 'crosswind';
  if (m <= -30 && m >= -150 && rel.alongM < runwayLengthM * 0.5 && lat > -L.centrelineM) return 'base';
  return 'outside';
}

/** "Established on final" limits. */
export const FINAL_LIMITS = {
  /** track within this of the runway heading, deg */
  trackDeg: 20,
  /** lateral tolerance: max(minLateralM, slope × distance) */
  minLateralM: 75,
  lateralSlope: 0.105, // ≈ 6°
  /** height window: below max(minCeilingM, slope × distance + marginM) */
  minCeilingM: 150,
  heightSlope: 0.105,
  heightMarginM: 150,
} as const;

/**
 * True when the aircraft is aligned with the extended centreline, on the approach side within
 * `maxDistanceM` of the threshold, at a plausible approach height (above the field, below a
 * generous ~6° wedge).
 */
export function isEstablishedOnFinal(rel: RunwayRelativeState, maxDistanceM: number): boolean {
  const F = FINAL_LIMITS;
  const d = -rel.alongM;
  if (d < -50 || d > maxDistanceM) return false;
  if (Math.abs(rel.relTrackDeg) > F.trackDeg) return false;
  if (Math.abs(rel.crossM) > Math.max(F.minLateralM, F.lateralSlope * Math.max(0, d))) return false;
  if (rel.heightM < -15) return false;
  return rel.heightM <= Math.max(F.minCeilingM, F.heightSlope * Math.max(0, d) + F.heightMarginM);
}

/** Within the pavement of the runway (with a margin), m. */
export function isOnRunway(rel: RunwayRelativeState, frame: RunwayFrame, marginM = 5): boolean {
  return rel.alongM >= -marginM && rel.alongM <= frame.lengthM + marginM && Math.abs(rel.crossM) <= frame.widthM / 2 + marginM;
}

/** Hold-short box around a runway end: near the threshold, beside or on the runway. */
export const HOLD_SHORT_BOX = { minAlongM: -250, maxAlongM: 400, maxLateralM: 250 } as const;

/** True when the position is in the hold-short area of this runway end. */
export function isAtHoldShort(rel: RunwayRelativeState): boolean {
  const B = HOLD_SHORT_BOX;
  return rel.alongM >= B.minAlongM && rel.alongM <= B.maxAlongM && Math.abs(rel.crossM) <= B.maxLateralM;
}

/**
 * Pattern entry a tower would assign from the arrival's position: straight-in when already
 * near the extended centreline on the approach side and heading roughly the runway heading;
 * base when on the pattern side ahead of the threshold; otherwise downwind (45° entry).
 */
export function choosePatternEntry(rel: RunwayRelativeState, side: TrafficSide): PatternEntry {
  const lat = rel.crossM * (side === 'left' ? -1 : 1);
  const d = -rel.alongM;
  if (d > 2 * NM && Math.abs(rel.crossM) <= d * Math.tan(Math.PI / 6) && Math.abs(rel.relTrackDeg) <= 60) return 'straight-in';
  if (d > 0.5 * NM && lat > 0) return 'base';
  return 'downwind';
}

/** Traffic side for an aircraft at `rel`: the side of the centreline it is on. */
export const sideOf = (rel: RunwayRelativeState): TrafficSide => (rel.crossM < 0 ? 'left' : 'right');

/** Distance (nm) and true bearing (deg) from a reference point to a position. */
export function rangeBearing(from: Geodetic, to: Geodetic): { nm: number; bearingDeg: number } {
  return { nm: greatCircleDistance(from, to) / NM, bearingDeg: initialBearingDeg(from, to) };
}
