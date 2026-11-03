/**
 * Resolves what the HSI shows from the raw `SimSnapshot`: the selected CDI source (GPS / NAV1 /
 * NAV2) with its course, deviation, TO/FROM and colour, and the two bearing pointers. Pure and
 * allocation-free (results are written into caller-owned objects), so it is unit-tested directly.
 *
 * GPS lateral full scale follows docs/research/05 §2.1: ENR 2.0 nm, TERM 1.0 nm within 31 nm of
 * the departure or destination waypoint (no APR/DPRT phases yet — see README).
 */
import { clamp, deltaDeg, wrap360 } from '../../core/math';
import { NM } from '../../core/units';
import type { FlightPlan, NavRadioState, SimSnapshot } from '../../core/types';
import { distanceNm } from './geo';
import { G, type CdiSource } from './palette';

/** Bearing-pointer source; `OFF` hides the pointer and its info window. */
export type BearingSource = 'OFF' | 'NAV1' | 'NAV2' | 'GPS';

/** GPS CDI full-scale deflection per flight phase, nm. */
export const GPS_CDI_SCALE_NM = Object.freeze({ ENR: 2.0, TERM: 1.0, APR: 0.3 });
/** Distance from the departure/destination inside which the GPS CDI uses TERM scaling, nm. */
export const TERMINAL_RADIUS_NM = 31;

export interface CdiState {
  source: CdiSource;
  /** HSI source label: 'GPS', 'VOR1', 'LOC1', 'VOR2', 'LOC2' */
  label: string;
  /** magenta for GPS, green for VOR/LOC */
  color: string;
  /** true when a deviation can be shown (signal received / active GPS leg) */
  valid: boolean;
  /** selected course (OBS) or desired track, degrees magnetic */
  courseDeg: number;
  /** lateral deviation −1..1 of full scale (2 dots), + = fly right */
  deviation: number;
  toFrom: 'to' | 'from' | 'off';
  /** GPS CDI scale annunciation ('ENR', 'TERM') or '' for VOR/LOC */
  scaleLabel: string;
  /** full-scale deflection in nm for GPS, NaN for angular (VOR/LOC) sources */
  fullScaleNm: number;
  /** DME / GPS distance to the station or active waypoint, nm (NaN when unknown) */
  distanceNm: number;
  /** station ident or active waypoint id ('' when none) */
  ident: string;
  isLocalizer: boolean;
  /** localizer flown on its back course (annunciated BC) */
  backCourse: boolean;
}

export interface BearingState {
  source: BearingSource;
  /** label shown in the info window ('NAV1', 'GPS', …) */
  label: string;
  valid: boolean;
  /** bearing to the station / waypoint, degrees magnetic */
  bearingDeg: number;
  distanceNm: number;
  ident: string;
}

export function createCdiState(): CdiState {
  return {
    source: 'NAV1', label: 'VOR1', color: G.green, valid: false, courseDeg: 0, deviation: 0, toFrom: 'off',
    scaleLabel: '', fullScaleNm: NaN, distanceNm: NaN, ident: '', isLocalizer: false, backCourse: false,
  };
}

export function createBearingState(source: BearingSource = 'OFF'): BearingState {
  return { source, label: source, valid: false, bearingDeg: 0, distanceNm: NaN, ident: '' };
}

/**
 * GPS CDI full scale (nm) and its annunciation for the active plan at the aircraft position:
 * TERM within 31 nm of the first or last waypoint, ENR otherwise.
 */
export function gpsCdiScale(plan: FlightPlan, lat: number, lon: number): { label: 'ENR' | 'TERM'; nm: number } {
  const wps = plan.waypoints;
  if (wps.length > 0) {
    const a = wps[0].position, b = wps[wps.length - 1].position;
    if (distanceNm(lat, lon, a.lat, a.lon) < TERMINAL_RADIUS_NM || distanceNm(lat, lon, b.lat, b.lon) < TERMINAL_RADIUS_NM) {
      return TERM;
    }
  }
  return ENR;
}
const ENR = Object.freeze({ label: 'ENR' as const, nm: GPS_CDI_SCALE_NM.ENR });
const TERM = Object.freeze({ label: 'TERM' as const, nm: GPS_CDI_SCALE_NM.TERM });

/** Active waypoint id of a plan, '' when the leg index is out of range. */
export function activeWaypointId(plan: FlightPlan | null): string {
  if (!plan) return '';
  const wp = plan.waypoints[plan.activeLeg];
  return wp ? wp.id : '';
}

/**
 * DME distance of a receiver in nm, NaN when there is no valid DME. Uses `dmeValid` when the nav
 * model provides it, else treats a positive distance from a received station as valid.
 */
export function dmeDistanceNm(nav: NavRadioState): number {
  const ok = nav.valid && (nav.dmeValid ?? nav.dmeNm > 0) && Number.isFinite(nav.dmeNm);
  return ok ? Math.max(0, nav.dmeNm) : NaN;
}

function navLabel(nav: NavRadioState, index: 1 | 2): string {
  if (index === 1) return nav.isLocalizer ? 'LOC1' : 'VOR1';
  return nav.isLocalizer ? 'LOC2' : 'VOR2';
}

/**
 * Fill `out` with the HSI data for the selected CDI source. `magVarDeg` is the local variation
 * (east positive, true = magnetic + var) used to convert the plan's true desired track.
 */
export function resolveCdi(s: SimSnapshot, source: CdiSource, magVarDeg: number, out: CdiState): CdiState {
  out.source = source;
  if (source === 'GPS') {
    const plan = s.plan;
    out.label = 'GPS'; out.color = G.magenta; out.isLocalizer = false; out.backCourse = false;
    out.ident = activeWaypointId(plan);
    if (plan && out.ident) {
      const sc = gpsCdiScale(plan, s.aircraft.geo.lat, s.aircraft.geo.lon);
      out.valid = true;
      out.courseDeg = wrap360(plan.desiredTrackDeg - magVarDeg);
      out.fullScaleNm = sc.nm; out.scaleLabel = sc.label;
      out.deviation = clamp(-(plan.crossTrackM / NM) / sc.nm, -1, 1);
      // FROM once the waypoint is behind: an OBS course flown past it, or the last waypoint passed
      out.toFrom = Math.abs(deltaDeg(plan.bearingToActiveDeg, plan.desiredTrackDeg)) > 90 ? 'from' : 'to';
      out.distanceNm = plan.distanceToActiveM / NM;
    } else {
      out.valid = false; out.deviation = 0; out.toFrom = 'off'; out.scaleLabel = 'ENR';
      out.fullScaleNm = GPS_CDI_SCALE_NM.ENR; out.distanceNm = NaN;
    }
    return out;
  }
  const index = source === 'NAV1' ? 1 : 2;
  const nav = index === 1 ? s.nav1 : s.nav2;
  out.label = navLabel(nav, index); out.color = G.green; out.isLocalizer = nav.isLocalizer;
  out.backCourse = nav.isLocalizer && nav.backCourse === true;
  out.courseDeg = wrap360(nav.obsDeg);
  out.valid = nav.valid;
  out.deviation = nav.valid ? clamp(nav.cdi, -1, 1) : 0;
  out.toFrom = nav.valid ? (nav.isLocalizer ? 'off' : nav.toFrom) : 'off';
  out.scaleLabel = ''; out.fullScaleNm = NaN;
  out.distanceNm = dmeDistanceNm(nav);
  out.ident = nav.valid ? nav.ident : '';
  return out;
}

/** Fill `out` with a bearing pointer's data. A localizer has no bearing, so its pointer is hidden. */
export function resolveBearing(s: SimSnapshot, source: BearingSource, magVarDeg: number, out: BearingState): BearingState {
  out.source = source; out.label = source;
  if (source === 'OFF') { out.valid = false; out.ident = ''; out.distanceNm = NaN; return out; }
  if (source === 'GPS') {
    const plan = s.plan;
    out.ident = activeWaypointId(plan);
    out.valid = !!plan && out.ident !== '';
    out.bearingDeg = plan ? wrap360(plan.bearingToActiveDeg - magVarDeg) : 0;
    out.distanceNm = plan && out.valid ? plan.distanceToActiveM / NM : NaN;
    return out;
  }
  const nav = source === 'NAV1' ? s.nav1 : s.nav2;
  out.valid = nav.valid && !nav.isLocalizer;
  out.bearingDeg = wrap360(nav.bearingDeg);
  out.distanceNm = dmeDistanceNm(nav);
  out.ident = nav.valid ? nav.ident : '';
  return out;
}
