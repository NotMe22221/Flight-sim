/**
 * Aircraft position relative to a runway end: along-track distance from the (displaced)
 * threshold and signed cross-track offset (+ right of the landing direction). Flat-earth
 * around the threshold is exact enough within a few km.
 */
import type { Airport, Geodetic, Runway } from '../core/types';
import { runwayEndDisplacementB, runwayEndIdents } from '../world/runwayIdents';

const D2R = Math.PI / 180;
const R = 6371000;

export interface RunwayEndRef {
  airport: Airport;
  runway: Runway;
  /** landing-direction designator, e.g. "28R" */
  ident: string;
  threshold: Geodetic;
  /** true heading of the landing direction, deg */
  headingDeg: number;
  /** usable length from this threshold to the far end, m */
  lengthM: number;
  widthM: number;
  displacedM: number;
}

/** Both landing directions of a runway as references. */
export function runwayEnds(airport: Airport, rw: Runway): [RunwayEndRef, RunwayEndRef] {
  const [a, b] = runwayEndIdents(rw);
  const headingA = rw.headingDeg;
  const headingB = (rw.headingDeg + 180) % 360;
  return [
    { airport, runway: rw, ident: a, threshold: rw.threshold, headingDeg: headingA, lengthM: rw.lengthM, widthM: rw.widthM, displacedM: rw.displacedThresholdM || 0 },
    { airport, runway: rw, ident: b, threshold: rw.end, headingDeg: headingB, lengthM: rw.lengthM, widthM: rw.widthM, displacedM: runwayEndDisplacementB(rw) },
  ];
}

export interface RunwayRelative {
  /** metres along the landing direction from the pavement threshold (negative = before it) */
  alongM: number;
  /** metres right (+) / left (−) of the centreline looking along the landing direction */
  crossM: number;
}

export function relativeToRunway(pos: Geodetic, end: RunwayEndRef, out: RunwayRelative = { alongM: 0, crossM: 0 }): RunwayRelative {
  const lat0 = end.threshold.lat * D2R;
  const dn = (pos.lat - end.threshold.lat) * D2R * R;
  const de = (pos.lon - end.threshold.lon) * D2R * R * Math.cos(lat0);
  const h = end.headingDeg * D2R;
  const fn = Math.cos(h), fe = Math.sin(h);
  out.alongM = dn * fn + de * fe;
  out.crossM = -dn * fe + de * fn;
  return out;
}

/** Is the position on the pavement of this runway (with a small margin)? */
export function onRunway(rel: RunwayRelative, end: RunwayEndRef, marginM = 3): boolean {
  return rel.alongM >= -marginM && rel.alongM <= end.lengthM + marginM && Math.abs(rel.crossM) <= end.widthM / 2 + marginM;
}

/**
 * Find the runway end best matching a position and track: the aircraft must be on or near
 * the pavement and travelling within 45° of the landing direction.
 */
export function matchRunwayEnd(pos: Geodetic, trackDeg: number, airports: Airport[]): { end: RunwayEndRef; rel: RunwayRelative } | null {
  let best: { end: RunwayEndRef; rel: RunwayRelative; score: number } | null = null;
  for (const ap of airports) {
    for (const rw of ap.runways) {
      for (const end of runwayEnds(ap, rw)) {
        const dh = Math.abs(((trackDeg - end.headingDeg) % 360 + 540) % 360 - 180);
        if (dh > 45) continue;
        const rel = relativeToRunway(pos, end);
        if (rel.alongM < -300 || rel.alongM > end.lengthM + 100) continue;
        if (Math.abs(rel.crossM) > end.widthM / 2 + 60) continue;
        const score = Math.abs(rel.crossM) + dh * 2;
        if (!best || score < best.score) best = { end, rel, score };
      }
    }
  }
  return best ? { end: best.end, rel: best.rel } : null;
}

/** Aim point (start of the aiming-point markings) distance from the threshold, m. */
export function aimPointM(lengthM: number): number {
  if (lengthM >= 2400) return 305;
  if (lengthM >= 1800) return 250;
  if (lengthM >= 1200) return 150;
  return Math.max(60, lengthM * 0.12);
}

/**
 * Aim point of a runway end measured from its pavement threshold (the `alongM` origin of
 * `relativeToRunway`), honouring a displaced landing threshold: the aiming-point markings start
 * `aimPointM(landing distance available)` past the displaced threshold. Equals
 * `aimPointM(end.lengthM)` when there is no displacement.
 */
export function aimAlongM(end: Pick<RunwayEndRef, 'lengthM' | 'displacedM'>): number {
  const d = Math.max(0, Math.min(end.displacedM || 0, end.lengthM * 0.5));
  return d + aimPointM(end.lengthM - d);
}
