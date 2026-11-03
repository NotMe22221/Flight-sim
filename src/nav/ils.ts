/**
 * ILS: synthesis from runway data and the antenna geometry the receiver model needs.
 *
 * OurAirports has no ILS rows, so we synthesise one for every paved runway end ≥ 4 000 ft at
 * large/medium airports (docs/research/05 §4.4). Frequencies are deterministic (FNV-1a hash of
 * `icao:ident` → one of the 40 localizer channels), unique within an airport, and every
 * synthetic record carries `synthetic: true` so the UI can say so.
 *
 * Geometry (all distances in metres; see `IlsGeometry`):
 *  - localizer antenna 300 m beyond the far (stop) end, on the extended centreline;
 *  - full-scale localizer deviation = atan(106.7 m / antenna→threshold distance), i.e. ±350 ft
 *    at the landing threshold, clamped to the 1.5°–3.0° half-width the standards allow;
 *  - glideslope antenna 300 m from the landing threshold, 120 m right of the centreline;
 *    the vertical geometry is referenced to the centreline point abeam the antenna;
 *  - marker beacons on the approach centreline: OM 4 nm (7.4 km), MM 1.05 km, IM 300 m from threshold.
 */
import type { Geodetic } from '../core/types';
import { clamp, wrap360 } from '../core/math';
import { FT, NM } from '../core/units';
import { destinationPoint, greatCircleDistance } from '../geo/wgs84';
import type { IlsInfo, RunwayEnd, RunwayRecord } from './navTypes';

const R2D = 180 / Math.PI;

/** Minimum runway length for a synthetic ILS, m (4 000 ft, docs/research/05 §0/§7). */
export const ILS_MIN_RUNWAY_M = 4000 * FT;
/** Localizer antenna distance beyond the stop end, m. */
export const LOC_ANTENNA_BEYOND_END_M = 300;
/** Half of the 700 ft course width at the threshold, m. */
export const LOC_HALF_WIDTH_AT_THRESHOLD_M = 106.7;
/** Allowed localizer half-width (full-scale angle), deg: total course width 3°–6°. */
export const LOC_HALF_WIDTH_MIN_DEG = 1.5;
export const LOC_HALF_WIDTH_MAX_DEG = 3.0;
/** Glideslope antenna setback from the landing threshold and lateral offset, m. */
export const GS_ANTENNA_SETBACK_M = 300;
export const GS_ANTENNA_LATERAL_M = 120;
/** Nominal glidepath angle and full-scale deviation, deg. */
export const GS_ANGLE_DEG = 3.0;
export const GS_FULL_SCALE_DEG = 0.7;
/** Marker beacon distances from the landing threshold, m: OM 4 nm (spec: 4–7 nm), MM ≈ 3 500 ft, IM ≈ 1 000 ft. */
export const MARKER_DISTANCES_M = { outer: 4 * NM, middle: 1050, inner: 300 } as const;
/** Marker reception window: ± along-track and ± lateral, m. */
export const MARKER_ALONG_TRACK_M = 300;
export const MARKER_LATERAL_M = 300;

/** Localizer channels: odd tenths 108.10–111.95 MHz (40 channels), in kHz. */
export const ILS_CHANNELS_KHZ: readonly number[] = (() => {
  const out: number[] = [];
  for (let mhz100 = 1081; mhz100 <= 1119; mhz100 += 2) {
    out.push(mhz100 * 100, mhz100 * 100 + 50);
  }
  return out;
})();

/** FNV-1a 32-bit hash of a string (deterministic across platforms). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The deterministic preferred channel index (0..39) for an airport/runway-end pair. */
export const ilsChannelIndex = (icao: string, runwayIdent: string): number => fnv1a(`${icao}:${runwayIdent}`) % ILS_CHANNELS_KHZ.length;

/** Synthetic ILS ident: 'I' + last three letters of the ICAO code (e.g. KSFO → ISFO). */
export const syntheticIlsIdent = (icao: string): string => `I${icao.slice(-3).toUpperCase()}`;

/**
 * Attach a synthetic ILS to every eligible end of the given runways (mutates `ends[i].ils`).
 * Eligible: paved (asphalt/concrete) and ≥ {@link ILS_MIN_RUNWAY_M}. Channels are assigned in
 * runway order starting at the hashed preference and probing forward so that no two ends at
 * the same airport share a frequency.
 */
export function synthesizeIls(icao: string, runways: RunwayRecord[]): void {
  const used = new Set<number>();
  for (const rw of runways) {
    if (rw.lengthM < ILS_MIN_RUNWAY_M) continue;
    if (rw.surface !== 'asphalt' && rw.surface !== 'concrete') continue;
    for (const end of rw.ends) {
      let ci = ilsChannelIndex(icao, end.ident);
      for (let probe = 0; probe < ILS_CHANNELS_KHZ.length && used.has(ci); probe++) ci = (ci + 1) % ILS_CHANNELS_KHZ.length;
      used.add(ci);
      const khz = ILS_CHANNELS_KHZ[ci];
      const ils: IlsInfo = {
        frequencyMHz: khz / 1000,
        frequencyKHz: khz,
        ident: syntheticIlsIdent(icao),
        glideslopeDeg: GS_ANGLE_DEG,
        locCourseDeg: end.headingDeg,
        synthetic: true,
      };
      end.ils = ils;
    }
    rw.ils = rw.ends[0].ils;
  }
}

/** Precomputed ILS positions for the receiver model (built once per runway end). */
export interface IlsGeometry {
  /** ICAO of the airport and runway-end ident */
  airport: string;
  runway: string;
  ident: string;
  frequencyKHz: number;
  /** front-course true heading, deg */
  courseDeg: number;
  /** landing threshold (displaced if applicable) with the threshold elevation */
  threshold: Geodetic;
  /** localizer antenna on the extended centreline beyond the stop end */
  locAntenna: Geodetic;
  /** full-scale localizer deviation angle (half the course width), deg */
  locFullScaleDeg: number;
  /** glideslope antenna (offset from the centreline) — for scenery placement */
  gsAntenna: Geodetic;
  /** centreline point abeam the GS antenna; the glidepath is referenced here */
  gsReference: Geodetic;
  glideslopeDeg: number;
  /** marker beacon positions on the approach centreline */
  markers: { outer: Geodetic; middle: Geodetic; inner: Geodetic };
  synthetic: boolean;
}

/** Landing threshold of a runway end: the pavement end moved by the displaced distance. */
export function landingThreshold(end: RunwayEnd): Geodetic {
  if (end.displacedThresholdM <= 0) return { lat: end.threshold.lat, lon: end.threshold.lon, alt: end.threshold.alt };
  return destinationPoint(end.threshold, end.headingDeg, end.displacedThresholdM, end.threshold.alt);
}

/**
 * Build the receiver geometry for a runway end that has an ILS. Returns undefined when the end
 * has none. `airportIcao` is only recorded for display.
 */
export function buildIlsGeometry(airportIcao: string, rw: RunwayRecord, endIndex: 0 | 1): IlsGeometry | undefined {
  const end = rw.ends[endIndex];
  const opposite = rw.ends[endIndex === 0 ? 1 : 0];
  const ils = end.ils;
  if (!ils) return undefined;
  const hdg = end.headingDeg;
  const thr = landingThreshold(end);
  // Anchor the antenna on the course line through the threshold (recorded headings are rounded
  // to whole degrees, so the far-end coordinate can sit a few metres off that line).
  const dLoc = greatCircleDistance(thr, opposite.threshold) + LOC_ANTENNA_BEYOND_END_M;
  const locAntenna = destinationPoint(thr, hdg, dLoc, opposite.threshold.alt);
  const locFullScaleDeg = clamp(Math.atan(LOC_HALF_WIDTH_AT_THRESHOLD_M / Math.max(dLoc, 1)) * R2D, LOC_HALF_WIDTH_MIN_DEG, LOC_HALF_WIDTH_MAX_DEG);
  const gsReference = destinationPoint(thr, hdg, GS_ANTENNA_SETBACK_M, thr.alt);
  const gsAntenna = destinationPoint(gsReference, wrap360(hdg + 90), GS_ANTENNA_LATERAL_M, thr.alt);
  const back = wrap360(hdg + 180);
  return {
    airport: airportIcao,
    runway: end.ident,
    ident: ils.ident,
    frequencyKHz: ils.frequencyKHz,
    courseDeg: ils.locCourseDeg,
    threshold: thr,
    locAntenna,
    locFullScaleDeg,
    gsAntenna,
    gsReference,
    glideslopeDeg: ils.glideslopeDeg,
    markers: {
      outer: destinationPoint(thr, back, MARKER_DISTANCES_M.outer, thr.alt),
      middle: destinationPoint(thr, back, MARKER_DISTANCES_M.middle, thr.alt),
      inner: destinationPoint(thr, back, MARKER_DISTANCES_M.inner, thr.alt),
    },
    synthetic: ils.synthetic,
  };
}
