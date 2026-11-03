/**
 * Pure navigation-radio geometry: VOR, ILS (localizer, glideslope, markers), DME and GPS leg
 * maths, plus `computeNavRadio` which fills a `NavRadioState` from an aircraft position and a
 * tuned station. Everything is allocation-free apart from the returned objects (pass `out` to
 * avoid even those); all inputs are plain `Geodetic`s so it runs in Node tests.
 *
 * Sign conventions (shared with the autopilot):
 *  - `cdi` ∈ [−1, 1], **+1 = fly right** (the course is to the right of the aircraft).
 *  - `gsDeviation` ∈ [−1, 1], **+1 = fly up** (the aircraft is below the glidepath).
 *  - cross-track error in metres is **+ right of course** (so `cdi ≈ −xtk / fullScale`).
 *  - radials and bearings are magnetic unless named `True`.
 */
import type { Geodetic, NavRadioState, Navaid } from '../core/types';
import { clamp, deltaDeg, wrap360 } from '../core/math';
import { G0, M_TO_FT, NM } from '../core/units';
import { EARTH_RADIUS, greatCircleDistance, initialBearingDeg } from '../geo/wgs84';
import { GS_FULL_SCALE_DEG, MARKER_ALONG_TRACK_M, MARKER_LATERAL_M } from './ils';
import type { IlsGeometry } from './ils';
import type { MarkerBeacon, NavRadioStateEx } from './navTypes';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** VOR CDI full-scale deflection, deg. */
export const VOR_FULL_SCALE_DEG = 10;
/** Cone of confusion radius over a VOR, m (receiver flags 'off'). */
export const VOR_CONE_RADIUS_M = 1 * NM;
/** Station antenna height above its elevation used for the radio horizon, m. */
export const STATION_ANTENNA_HEIGHT_M = 10;
/** Localizer usable range, nm (within ±10° of course) and the GS usable range, nm. */
export const LOC_RANGE_NM = 18;
export const LOC_WIDE_RANGE_NM = 10;
export const GS_RANGE_NM = 10;
/** Default bank angle for turn-anticipation geometry, deg. */
export const TURN_BANK_DEG = 25;

// ───────────────────────────── basic geometry ─────────────────────────────

/** Great-circle (ground) distance, m. */
export const groundDistanceM = (a: Geodetic, b: Geodetic): number => greatCircleDistance(a, b);

/** True bearing from a to b, deg 0..360. */
export const bearingTrueDeg = (a: Geodetic, b: Geodetic): number => initialBearingDeg(a, b);

/** DME slant range in nautical miles from two 3-D positions. */
export function dmeSlantNm(aircraft: Geodetic, station: Geodetic): number {
  const g = greatCircleDistance(aircraft, station);
  const dh = aircraft.alt - station.alt;
  return Math.sqrt(g * g + dh * dh) / NM;
}

/**
 * VHF radio line-of-sight range, nm: 1.23·(√h₁ + √h₂) with heights in feet above the common
 * datum (mean sea level here). Heights below zero count as zero.
 */
export function radioHorizonNm(aircraftAltM: number, stationAltM: number): number {
  const hAcFt = Math.max(aircraftAltM, 0) * M_TO_FT;
  const hStFt = Math.max(stationAltM + STATION_ANTENNA_HEIGHT_M, 0) * M_TO_FT;
  return 1.23 * (Math.sqrt(hAcFt) + Math.sqrt(hStFt));
}

/** True when a VHF station at `distanceM` is receivable: within line of sight and its published range. */
export function inVhfRange(distanceM: number, aircraftAltM: number, stationAltM: number, stationRangeNm: number): boolean {
  const limitNm = Math.min(radioHorizonNm(aircraftAltM, stationAltM), stationRangeNm);
  return distanceM / NM <= limitNm;
}

// ───────────────────────────── VOR ─────────────────────────────

/** Magnetic radial from the station the aircraft is on (uses the station's declination), deg 0..360. */
export function vorRadialDeg(station: Navaid, aircraft: Geodetic): number {
  return wrap360(initialBearingDeg(station.position, aircraft) - station.magneticVariationDeg);
}

/** Result of {@link vorDeviationDeg}. */
export interface VorDeviation { toFrom: 'to' | 'from'; /** deg, + = fly right, unclamped */ deviationDeg: number }

/**
 * VOR course deviation for an OBS course and the radial the aircraft is on: the TO/FROM sense
 * and the deviation in degrees (+ = fly right), unclamped. Pass `out` to avoid allocating.
 */
export function vorDeviationDeg(obsDeg: number, radialDeg: number, out?: VorDeviation): VorDeviation {
  const o = out ?? ({} as VorDeviation);
  const d = deltaDeg(obsDeg, radialDeg); // course − radial, (−180, 180]
  if (Math.abs(d) <= 90) { o.toFrom = 'from'; o.deviationDeg = d; }
  else { o.toFrom = 'to'; o.deviationDeg = deltaDeg(180, d); }
  return o;
}

// ───────────────────────────── ILS ─────────────────────────────

/** Result of {@link localizerDeviation}. */
export interface LocalizerDeviation { /** −1..1, + = fly right */ cdi: number; /** signed angle off the course line, deg */ angleDeg: number; backCourse: boolean }

/**
 * Localizer deviation. `angleDeg` is the angle between the course line (seen from the antenna)
 * and the aircraft; `cdi` is that normalised to full scale and signed so + = fly right, with
 * reverse sensing on the back course exactly as a real receiver without BC mode.
 */
export function localizerDeviation(ils: IlsGeometry, aircraft: Geodetic, out?: LocalizerDeviation): LocalizerDeviation {
  const o = out ?? ({} as LocalizerDeviation);
  const brgFromLoc = initialBearingDeg(ils.locAntenna, aircraft);
  const offFront = deltaDeg(brgFromLoc, ils.courseDeg + 180); // 0 on the front course centreline
  const backCourse = Math.abs(offFront) > 90;
  // Geographic side relative to the front-course direction decides the needle: an aircraft on
  // the right-hand side (as seen flying the front course) always shows "fly left".
  const angleDeg = backCourse ? -deltaDeg(brgFromLoc, ils.courseDeg) : offFront;
  o.cdi = clamp(angleDeg / ils.locFullScaleDeg, -1, 1); o.angleDeg = angleDeg; o.backCourse = backCourse;
  return o;
}

/** Result of {@link glideslopeDeviation}. */
export interface GlideslopeDeviation { /** −1..1, + = fly up */ gs: number; /** glidepath − elevation angle, deg */ errorDeg: number; /** ground distance to the GS reference, m */ distanceM: number; /** on the approach side */ inFront: boolean }

/**
 * Glideslope deviation relative to the glidepath from the GS reference point: full-scale
 * normalised deviation (+ = fly up), the raw error in degrees and whether the aircraft is on
 * the approach side of the reference point.
 */
export function glideslopeDeviation(ils: IlsGeometry, aircraft: Geodetic, out?: GlideslopeDeviation): GlideslopeDeviation {
  const o = out ?? ({} as GlideslopeDeviation);
  const distanceM = greatCircleDistance(ils.gsReference, aircraft);
  const dh = aircraft.alt - ils.gsReference.alt;
  const elevDeg = Math.atan2(dh, Math.max(distanceM, 1)) * R2D;
  const errorDeg = ils.glideslopeDeg - elevDeg; // + when below the path → fly up
  o.gs = clamp(errorDeg / GS_FULL_SCALE_DEG, -1, 1); o.errorDeg = errorDeg; o.distanceM = distanceM;
  o.inFront = Math.abs(deltaDeg(initialBearingDeg(ils.gsReference, aircraft), ils.courseDeg + 180)) < 90;
  return o;
}

// Scratch results reused by the per-frame assembly below (keeps the hot path allocation-free).
const vorScratch: VorDeviation = { toFrom: 'from', deviationDeg: 0 };
const locScratch: LocalizerDeviation = { cdi: 0, angleDeg: 0, backCourse: false };
const gsScratch: GlideslopeDeviation = { gs: 0, errorDeg: 0, distanceM: 0, inFront: false };

/** Which marker beacon (if any) the aircraft is over: within ±300 m along track and ±300 m laterally. */
export function markerBeacon(ils: IlsGeometry, aircraft: Geodetic): MarkerBeacon {
  const approachDeg = ils.courseDeg; // flying toward the runway
  for (const name of ['outer', 'middle', 'inner'] as const) {
    const m = ils.markers[name];
    const d = greatCircleDistance(m, aircraft);
    if (d > MARKER_ALONG_TRACK_M + MARKER_LATERAL_M) continue;
    const brg = initialBearingDeg(m, aircraft) * D2R;
    const along = d * Math.cos(brg - approachDeg * D2R);
    const lateral = d * Math.sin(brg - approachDeg * D2R);
    if (Math.abs(along) <= MARKER_ALONG_TRACK_M && Math.abs(lateral) <= MARKER_LATERAL_M) return name;
  }
  return null;
}

// ───────────────────────────── GPS leg geometry ─────────────────────────────

/** Result of {@link legGeometry}. */
export interface LegGeometry {
  /** cross-track error, m, + right of course */
  crossTrackM: number;
  /** distance from leg start projected onto the course, m (negative before the start) */
  alongTrackM: number;
  /** leg length, m */
  legLengthM: number;
  /** remaining along-track distance to the leg end, m */
  remainingM: number;
  /** great-circle course at the aircraft's abeam point toward the leg end, deg true */
  desiredTrackDeg: number;
  /** direct bearing and distance to the leg end */
  bearingToEndDeg: number;
  distanceToEndM: number;
}

/**
 * Cross-track / along-track geometry of position P relative to the great-circle leg A→B.
 * Standard spherical formulas (Williams' Aviation Formulary), allocation-free apart from `out`.
 */
export function legGeometry(a: Geodetic, b: Geodetic, p: Geodetic, out?: LegGeometry): LegGeometry {
  const R = EARTH_RADIUS;
  const legLengthM = greatCircleDistance(a, b);
  const d13 = greatCircleDistance(a, p) / R;
  const th13 = initialBearingDeg(a, p) * D2R;
  const th12 = initialBearingDeg(a, b) * D2R;
  const xt = Math.asin(clamp(Math.sin(d13) * Math.sin(th13 - th12), -1, 1));
  const cosXt = Math.cos(xt);
  let at = Math.acos(clamp(Math.cos(d13) / Math.max(Math.abs(cosXt), 1e-12), -1, 1));
  if (Math.abs(deltaDeg(th13 * R2D, th12 * R2D)) > 90) at = -at; // behind the start
  const alongTrackM = at * R;
  const crossTrackM = xt * R;
  const distanceToEndM = greatCircleDistance(p, b);
  const bearingToEndDeg = initialBearingDeg(p, b);
  // Desired track: the course of the leg at the aircraft's abeam point. For a short leg this is
  // the initial bearing; for long legs it follows the great circle. Derived from the bearing to
  // the end corrected by the (small) angle subtended by the cross-track offset.
  const remainingM = legLengthM - alongTrackM;
  const desiredTrackDeg = remainingM > 1 ? wrap360(bearingToEndDeg + (Math.atan2(crossTrackM, Math.max(remainingM, 1)) * R2D)) : wrap360(th12 * R2D);
  const o = out ?? ({} as LegGeometry);
  o.crossTrackM = crossTrackM; o.alongTrackM = alongTrackM; o.legLengthM = legLengthM; o.remainingM = remainingM;
  o.desiredTrackDeg = desiredTrackDeg; o.bearingToEndDeg = bearingToEndDeg; o.distanceToEndM = distanceToEndM;
  return o;
}

/** Cross-track error of P from leg A→B, m, + right of course. */
export const crossTrackM = (a: Geodetic, b: Geodetic, p: Geodetic): number => legGeometry(a, b, p).crossTrackM;

/** Along-track distance of P from A along leg A→B, m. */
export const alongTrackM = (a: Geodetic, b: Geodetic, p: Geodetic): number => legGeometry(a, b, p).alongTrackM;

/** Desired track (great-circle course) of leg A→B at P, deg true. */
export const desiredTrackDeg = (a: Geodetic, b: Geodetic, p: Geodetic): number => legGeometry(a, b, p).desiredTrackDeg;

/** Turn radius for a coordinated turn at ground speed `gsMs` and bank `bankDeg`, m: r = V² / (g·tan φ). */
export function turnRadiusM(gsMs: number, bankDeg = TURN_BANK_DEG): number {
  return (gsMs * gsMs) / (G0 * Math.tan(Math.max(bankDeg, 1) * D2R));
}

/**
 * Distance before a waypoint at which to start a fly-by turn through `courseChangeDeg`:
 * r·tan(Δ/2), capped at the radius for turns beyond 90° (abeam logic takes over).
 */
export function turnAnticipationM(gsMs: number, courseChangeDeg: number, bankDeg = TURN_BANK_DEG): number {
  const r = turnRadiusM(gsMs, bankDeg);
  const half = Math.min(Math.abs(courseChangeDeg), 90) / 2;
  return r * Math.tan(half * D2R);
}

// ───────────────────────────── NavRadioState assembly ─────────────────────────────

/** What the radio head is set to. */
export interface NavTuning {
  activeKHz: number;
  standbyKHz: number;
  obsDeg: number;
}

/** A fresh, flagged (no signal) radio state. */
export function emptyNavRadioState(tuning?: Partial<NavTuning>, out?: NavRadioStateEx): NavRadioStateEx {
  const o = out ?? ({} as NavRadioStateEx);
  o.activeKHz = tuning?.activeKHz ?? 108_000;
  o.standbyKHz = tuning?.standbyKHz ?? 108_000;
  o.obsDeg = tuning?.obsDeg ?? 0;
  o.ident = ''; o.valid = false; o.cdi = 0; o.toFrom = 'off'; o.gsDeviation = 0; o.gsValid = false;
  o.isLocalizer = false; o.dmeNm = 0; o.bearingDeg = 0; o.radialDeg = 0;
  o.backCourse = false; o.marker = null; o.distanceM = Infinity;
  return o;
}

/**
 * Fill a radio state from a VOR/DME-type station.
 * @param aircraft position (alt m MSL)
 * @param magVarDeg declination at the aircraft (for the magnetic bearing-to)
 */
export function computeVorRadio(aircraft: Geodetic, magVarDeg: number, station: Navaid, tuning: NavTuning, out?: NavRadioStateEx): NavRadioStateEx {
  const o = emptyNavRadioState(tuning, out);
  const distanceM = greatCircleDistance(aircraft, station.position);
  o.distanceM = distanceM;
  o.ident = station.id;
  o.radialDeg = vorRadialDeg(station, aircraft);
  o.bearingDeg = wrap360(initialBearingDeg(aircraft, station.position) - magVarDeg);
  o.dmeNm = dmeSlantNm(aircraft, station.position);
  const isNdb = station.type === 'NDB';
  const inRange = isNdb ? distanceM / NM <= station.rangeNm : inVhfRange(distanceM, aircraft.alt, station.position.alt, station.rangeNm);
  const hasAzimuth = station.type === 'VOR' || station.type === 'VOR-DME' || station.type === 'VORTAC';
  const overhead = distanceM < VOR_CONE_RADIUS_M;
  o.valid = inRange;
  if (inRange && hasAzimuth && !overhead) {
    const dev = vorDeviationDeg(tuning.obsDeg, o.radialDeg, vorScratch);
    o.cdi = clamp(dev.deviationDeg / VOR_FULL_SCALE_DEG, -1, 1);
    o.toFrom = dev.toFrom;
  } else {
    o.cdi = 0;
    o.toFrom = 'off';
  }
  return o;
}

/** Fill a radio state from an ILS. `gsDeviation` + = fly up; `cdi` + = fly right. */
export function computeIlsRadio(aircraft: Geodetic, magVarDeg: number, ils: IlsGeometry, tuning: NavTuning, out?: NavRadioStateEx): NavRadioStateEx {
  const o = emptyNavRadioState(tuning, out);
  o.isLocalizer = true;
  o.ident = ils.ident;
  const distanceM = greatCircleDistance(aircraft, ils.threshold);
  o.distanceM = distanceM;
  o.dmeNm = dmeSlantNm(aircraft, ils.threshold);
  o.bearingDeg = wrap360(initialBearingDeg(aircraft, ils.threshold) - magVarDeg);
  o.radialDeg = wrap360(ils.courseDeg - magVarDeg); // magnetic front course, handy for the HSI
  const loc = localizerDeviation(ils, aircraft, locScratch);
  const distLocNm = greatCircleDistance(aircraft, ils.locAntenna) / NM;
  const absAngle = Math.abs(loc.angleDeg);
  const usableNm = absAngle <= 10 ? LOC_RANGE_NM : absAngle <= 35 ? LOC_WIDE_RANGE_NM : 0;
  const losOk = inVhfRange(distLocNm * NM, aircraft.alt, ils.locAntenna.alt, Infinity);
  o.valid = distLocNm <= usableNm && losOk;
  o.backCourse = loc.backCourse;
  o.cdi = o.valid ? loc.cdi : 0;
  if (o.valid) {
    const gs = glideslopeDeviation(ils, aircraft, gsScratch);
    o.gsValid = !loc.backCourse && gs.inFront && gs.distanceM / NM <= GS_RANGE_NM && absAngle <= 8;
    o.gsDeviation = o.gsValid ? gs.gs : 0;
    o.marker = markerBeacon(ils, aircraft);
  }
  return o;
}

/** Station types `computeNavRadio` accepts. */
export type TunedStation = Navaid | IlsGeometry | undefined;

const isIls = (s: Navaid | IlsGeometry): s is IlsGeometry => 'locAntenna' in s;

/**
 * Produce the `NavRadioState` for one NAV receiver. Pass the station the database resolved
 * for the active frequency (`findNavaidByFrequency` / `findIlsByFrequency`), or undefined when
 * nothing is tuned (→ flagged state).
 */
export function computeNavRadio(aircraft: Geodetic, magVarDeg: number, station: TunedStation, tuning: NavTuning, out?: NavRadioStateEx): NavRadioStateEx {
  if (!station) return emptyNavRadioState(tuning, out);
  return isIls(station) ? computeIlsRadio(aircraft, magVarDeg, station, tuning, out) : computeVorRadio(aircraft, magVarDeg, station, tuning, out);
}

/** Narrow an extended state to the core contract (no copy; same object). */
export const asNavRadioState = (s: NavRadioStateEx): NavRadioState => s;
