/**
 * MSFS-style numbered options for the current state: a pending readback first, then the calls
 * that make sense in this phase, each labelled with the facility and frequency it goes to.
 * Rebuilt only when the session marks the menu dirty.
 */
import type { Airport } from '../core/types';
import { NM } from '../core/units';
import {
  callInbound, cancelFlightFollowing, cancelInbound, cancelTakeoff, departureRunway, listenAtis, readBack, readyForDeparture, requestClearance,
  requestClosedTraffic, requestFlightFollowing, requestFrequencyChange, requestTaxi, selectDestination, announceInbound,
} from './actions';
import type { Facility, FacilityKind } from './field';
import { legPhrase } from './messages';
import {
  announceDeparture, announceLeavingArea, announceLeg, announceRemainInPattern, announceTaxi, clearOfRunway, goingAround,
  leavePattern, reportPosition, requestOption,
} from './patternActions';
import { frequency, runway as rwySpoken } from './phraseology';
import type { AtcSession, FieldCtx } from './session';

/** One option: its label and what selecting it does. */
export interface MenuItem {
  label: string;
  run: () => void;
}

/** Most options shown at once (keys 1–9 and 0). */
export const MAX_OPTIONS = 10;
/** Airports offered as destinations / ATIS sources within this range, m. */
const NEARBY_M = 30 * NM;
/** Flight following is offered by a radar facility within this range, m. */
const RADAR_RANGE_M = 60 * NM;

const KIND_WORD: Readonly<Record<FacilityKind, string>> = {
  ATIS: 'ATIS', AWOS: 'AWOS', CLD: 'Clearance', GND: 'Ground', TWR: 'Tower', DEP: 'Departure', APP: 'Approach', CTAF: 'CTAF',
};

/** " (Ground 121.8)" */
const via = (f: Facility): string => ` (${KIND_WORD[f.kind]} ${frequency(f.mhz).text})`;

function atisItem(s: AtcSession, ctx: FieldCtx, withName: boolean): MenuItem | null {
  const f = ctx.info.atis ?? ctx.info.awos;
  if (!f) return null;
  const what = withName ? `${ctx.info.shortName} ${KIND_WORD[f.kind]}` : KIND_WORD[f.kind];
  return { label: `Listen to ${what} (${frequency(f.mhz).text})`, run: () => listenAtis(s, ctx) };
}

function departureItems(s: AtcSession, ctx: FieldCtx, out: MenuItem[]): void {
  const { ground, clearance } = ctx.info;
  if (ground) {
    if (clearance && !s.clearanceReceived) out.push({ label: `Request VFR departure clearance${via(clearance)}`, run: () => requestClearance(s, ctx) });
    out.push({ label: `Request taxi for VFR departure${via(ground)}`, run: () => requestTaxi(s, ctx, 'departure') });
    out.push({ label: `Request taxi for closed traffic${via(ground)}`, run: () => requestTaxi(s, ctx, 'closed-traffic') });
  } else {
    // the runway the call will announce (the in-use parallel nearest the aircraft)
    const ref = departureRunway(s, ctx);
    if (!ref) return;
    const c = ctx.info.ctaf, rwy = rwySpoken(ref.ident).text;
    out.push({ label: `Announce taxi to runway ${rwy} for departure${via(c)}`, run: () => announceTaxi(s, ctx, 'departure', ref) });
    out.push({ label: `Announce taxi to runway ${rwy} for closed traffic${via(c)}`, run: () => announceTaxi(s, ctx, 'closed-traffic', ref) });
  }
}

function readyItems(s: AtcSession, ctx: FieldCtx, out: MenuItem[]): void {
  const rwy = rwySpoken(s.runway?.ident ?? ctx.inUse?.primary.ident ?? '').text;
  const tail = s.intent === 'closed-traffic' ? ', remaining in the pattern' : '';
  if (ctx.info.tower) out.push({ label: `Ready for departure, runway ${rwy}${tail}${via(ctx.info.tower)}`, run: () => readyForDeparture(s, ctx) });
  else out.push({ label: `Announce departing runway ${rwy}${tail}${via(ctx.info.ctaf)}`, run: () => announceDeparture(s, ctx) });
}

/** Nearby airports (nearest first) as cached contexts, without refreshing their ATIS. */
function nearbyFields(s: AtcSession, max: number, rangeM: number): FieldCtx[] {
  if (!s.ac) return [];
  return s.nav.nearestAirports(s.ac.geo, max, rangeM / NM).map((a: Airport) => s.peekField(a));
}

function enrouteItems(s: AtcSession, out: MenuItem[]): void {
  const ff = s.flightFollowing;
  if (ff) out.push({ label: `Cancel flight following${via(ff)}`, run: () => cancelFlightFollowing(s) });
  else {
    const radar = nearbyFields(s, 10, RADAR_RANGE_M).find((c) => c.info.departure || c.info.approach);
    const f = radar ? radar.info.departure ?? radar.info.approach : undefined;
    if (radar && f) out.push({ label: `Request VFR flight following${via(f)}`, run: () => requestFlightFollowing(s, s.fieldCtx(radar.info.airport)) });
  }
  const near = nearbyFields(s, 3, NEARBY_M);
  for (const c of near) {
    const ap = c.info.airport;
    out.push({ label: `Prepare to land at ${c.info.shortName} (${ap.icao})`, run: () => selectDestination(s, ap) });
  }
  const withAtis = near.find((c) => c.info.atis || c.info.awos);
  if (withAtis) {
    const item = atisItem(s, withAtis, true);
    if (item) out.push({ label: item.label, run: () => listenAtis(s, s.fieldCtx(withAtis.info.airport)) });
  }
}

function inboundItems(s: AtcSession, ctx: FieldCtx, out: MenuItem[]): void {
  const atis = atisItem(s, ctx, true);
  if (atis) out.push(atis);
  const ff = s.flightFollowing;
  if (ff) out.push({ label: `Cancel flight following${via(ff)}`, run: () => cancelFlightFollowing(s) });
  const twr = ctx.info.tower;
  if (twr) {
    out.push({ label: `Inbound for landing, full stop${via(twr)}`, run: () => callInbound(s, ctx, 'full-stop') });
    out.push({ label: `Inbound for touch and go${via(twr)}`, run: () => callInbound(s, ctx, 'touch-and-go') });
  } else {
    out.push({ label: `Announce inbound, full stop${via(ctx.info.ctaf)}`, run: () => announceInbound(s, ctx, 'full-stop') });
    out.push({ label: `Announce inbound, touch and go${via(ctx.info.ctaf)}`, run: () => announceInbound(s, ctx, 'touch-and-go') });
  }
  out.push({ label: `Cancel landing at ${ctx.info.shortName}, resume en route`, run: () => cancelInbound(s) });
}

function patternItems(s: AtcSession, ctx: FieldCtx, out: MenuItem[]): void {
  const twr = ctx.info.tower, rwy = s.runway?.ident ?? '';
  const leg = s.leg;
  if (twr) {
    // Position reports and "going around" only make sense on an approach (not right after a go-around).
    const onApproach = s.flags.armed && s.landingClearance === 'none';
    if (onApproach && (leg === 'downwind' || leg === 'base' || leg === 'final')) {
      out.push({ label: `Report ${legPhrase(leg, s.side, rwy).text}${via(twr)}`, run: () => reportPosition(s, ctx) });
    }
    if (s.landingIntent === 'full-stop') out.push({ label: `Request touch and go${via(twr)}`, run: () => requestOption(s, ctx, 'touch-and-go') });
    else out.push({ label: `Request full stop${via(twr)}`, run: () => requestOption(s, ctx, 'full-stop') });
    if (s.landingClearance !== 'none' || (onApproach && leg === 'final')) out.push({ label: `Going around${via(twr)}`, run: () => goingAround(s, ctx) });
    out.push({ label: `Request frequency change, leaving the pattern${via(twr)}`, run: () => leavePattern(s, ctx) });
    return;
  }
  const c = ctx.info.ctaf;
  if (leg !== 'outside') out.push({ label: `Announce ${legPhrase(leg, s.side, rwy, false).text}${via(c)}`, run: () => announceLeg(s, ctx) });
  out.push({ label: `Announce going around${via(c)}`, run: () => goingAround(s, ctx) });
  out.push({ label: `Announce departing the pattern${via(c)}`, run: () => announceLeavingArea(s, ctx) });
}

/** Build the option list for the session's current state. */
export function buildMenu(s: AtcSession): MenuItem[] {
  const out: MenuItem[] = [];
  const rb = s.pendingReadback;
  if (rb) out.push({ label: rb.label, run: () => readBack(s) });
  const ctx = s.field;
  switch (s.phase) {
    case 'PARKED':
    case 'TAXI_IN': {
      if (!ctx) break;
      const atis = atisItem(s, ctx, false);
      if (atis) out.push(atis);
      departureItems(s, ctx, out);
      break;
    }
    case 'TAXI_CLEARED':
    case 'HOLDING_SHORT': {
      if (!ctx) break;
      readyItems(s, ctx, out);
      const atis = atisItem(s, ctx, false);
      if (atis) out.push(atis);
      break;
    }
    case 'CLEARED_TAKEOFF':
      if (ctx) out.push({ label: ctx.info.tower ? `Unable, holding short${via(ctx.info.tower)}` : 'Cancel departure, holding short', run: () => cancelTakeoff(s, ctx) });
      break;
    case 'DEPARTING':
      if (!ctx) break;
      if (ctx.info.tower) {
        out.push({ label: `Request frequency change${via(ctx.info.tower)}`, run: () => requestFrequencyChange(s, ctx) });
        out.push({ label: `Request closed traffic${via(ctx.info.tower)}`, run: () => requestClosedTraffic(s, ctx) });
      } else {
        out.push({ label: `Announce departing the area${via(ctx.info.ctaf)}`, run: () => announceLeavingArea(s, ctx) });
        out.push({ label: `Announce remaining in the pattern${via(ctx.info.ctaf)}`, run: () => announceRemainInPattern(s, ctx) });
      }
      break;
    case 'ENROUTE':
      enrouteItems(s, out);
      break;
    case 'INBOUND':
      if (ctx) inboundItems(s, ctx, out);
      break;
    case 'PATTERN':
      if (ctx) patternItems(s, ctx, out);
      break;
    case 'LANDED':
      if (!ctx) break;
      if (ctx.info.ground) out.push({ label: `Report clear of runway, request taxi to parking${via(ctx.info.ground)}`, run: () => clearOfRunway(s, ctx) });
      else out.push({ label: `Announce clear of runway ${rwySpoken(s.runway?.ident ?? '').text}${via(ctx.info.ctaf)}`.replace('  ', ' '), run: () => clearOfRunway(s, ctx) });
      break;
  }
  if (out.length === 0) out.push({ label: 'No ATC facility in range', run: () => undefined });
  return out.slice(0, MAX_OPTIONS);
}
