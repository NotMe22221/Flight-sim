/**
 * Instrument approaches for the G1000 PROC page. The dataset has no procedure coding, so every
 * ILS-equipped runway end (real or synthesised, see ils.ts) yields one "ILS RWY xx" approach with
 * two GPS fixes on the localizer course: the final approach fix `FFxx` at {@link FAF_DISTANCE_NM}
 * from the landing threshold (crossed at the glideslope height) and the runway fix `RWxx` at the
 * threshold. Loading the approach appends those fixes to the flight plan and tunes the localizer.
 */
import type { Airport, Geodetic, Waypoint } from '../core/types';
import { wrap360 } from '../core/math';
import { NM } from '../core/units';
import { destinationPoint } from '../geo/wgs84';
import { runwayEnds } from './airportsData';
import { landingThreshold } from './ils';

/** Distance of the synthetic final approach fix from the threshold, nm. */
export const FAF_DISTANCE_NM = 5;

export interface ApproachInfo {
  /** e.g. "ILS 28R" */
  name: string;
  airportIcao: string;
  /** runway end ident, e.g. "28R" */
  runway: string;
  /** localizer frequency, kHz */
  frequencyKHz: number;
  /** localizer ident, e.g. "IOAK" */
  ident: string;
  /** localizer (final approach) course, deg true */
  courseTrueDeg: number;
  glideslopeDeg: number;
  /** landing threshold (after any displacement) */
  threshold: Geodetic;
  synthetic: boolean;
}

/** ILS approaches at an airport, sorted by runway ident. */
export function ilsApproaches(airport: Airport): ApproachInfo[] {
  const out: ApproachInfo[] = [];
  for (const rw of airport.runways) {
    for (const end of runwayEnds(rw)) {
      const ils = end.ils;
      if (!ils || !(ils.frequencyKHz > 0)) continue;
      out.push({
        name: `ILS ${end.ident}`,
        airportIcao: airport.icao,
        runway: end.ident,
        frequencyKHz: ils.frequencyKHz,
        ident: ils.ident,
        courseTrueDeg: wrap360(ils.locCourseDeg),
        glideslopeDeg: ils.glideslopeDeg > 0 ? ils.glideslopeDeg : 3,
        threshold: landingThreshold(end),
        synthetic: ils.synthetic,
      });
    }
  }
  out.sort((a, b) => a.runway.localeCompare(b.runway, 'en', { numeric: true }));
  return out;
}

/**
 * The approach's GPS fixes: `FFxx` on the extended centreline at `fafNm` with an altitude
 * constraint on the glideslope, then `RWxx` at the threshold.
 */
export function approachWaypoints(a: ApproachInfo, fafNm = FAF_DISTANCE_NM): Waypoint[] {
  const thr = a.threshold;
  const fafAlt = thr.alt + Math.tan((a.glideslopeDeg * Math.PI) / 180) * fafNm * NM;
  const faf = destinationPoint(thr, a.courseTrueDeg + 180, fafNm * NM, fafAlt);
  return [
    { id: `FF${a.runway}`, position: faf, type: 'fix', altConstraintM: fafAlt },
    { id: `RW${a.runway}`, position: { lat: thr.lat, lon: thr.lon, alt: thr.alt }, type: 'fix', altConstraintM: thr.alt },
  ];
}
