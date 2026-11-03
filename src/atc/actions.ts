/**
 * Pilot actions behind the menu options. Each one transmits the pilot's call immediately and,
 * at towered fields, schedules the controller's reply (1.5–2.75 s of sim time later); the
 * state change happens when the reply goes out. CTAF self-announcements change state at once.
 */
import type { Airport } from '../core/types';
import { FT, NM } from '../core/units';
import { patternSideFor, type RunwayRef } from './field';
import {
  choosePatternEntry, makeRunwayFrame, rangeBearing, relativeTo, sideOf, type PatternEntry, type RunwayFrame, type TrafficSide,
} from './geometry';
import { atc, ctaf, entryPhrase, positionFrom, pilot, readback } from './messages';
import { runway as rwySpoken, spoken, type Spoken } from './phraseology';
import type { AtcSession, FieldCtx } from './session';
import type { DepartureIntent, LandingIntent } from './types';

const altFt = (s: AtcSession): number => (s.ac ? s.ac.altitudeMslM / FT : 0);

/** Broadcast the ATIS (or AWOS) of a field and remember the letter heard. */
export function listenAtis(s: AtcSession, ctx: FieldCtx): void {
  const fac = ctx.info.atis ?? ctx.info.awos;
  if (!fac) return;
  s.refreshAtis(ctx);
  const r = ctx.report;
  if (!r) return;
  s.tune(fac);
  s.radio.transmit('atc', spoken(r.text, r.speech), fac.mhz);
  if (ctx.info.atis) s.atisHeard.set(ctx.info.airport.icao, r.letter);
  s.menuDirty = true;
}

/** Read back the pending instruction (no reply); runs its follow-up (e.g. the frequency change). */
export function readBack(s: AtcSession): void {
  const rb = s.pendingReadback;
  if (!rb) return;
  s.pendingReadback = null;
  s.pilotSays(rb.facility, rb.build);
  rb.then?.();
}

/** Runway in use nearest to the aircraft (among parallels). */
export function departureRunway(s: AtcSession, ctx: FieldCtx): RunwayRef | null {
  const inUse = ctx.inUse;
  if (!inUse) return null;
  if (inUse.all.length < 2 || !s.ac) return inUse.primary;
  let best = inUse.primary, bestD = Infinity;
  for (const r of inUse.all) {
    const d = rangeBearing(r.threshold, s.ac.geo).nm;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/** Landing runway, traffic side and entry for an arrival at its current position. */
export function arrivalPlan(s: AtcSession, ctx: FieldCtx): { frame: RunwayFrame; side: TrafficSide; entry: PatternEntry } | null {
  const inUse = ctx.inUse, ac = s.ac;
  if (!inUse || !ac) return null;
  const ap = ctx.info.airport;
  const trackDeg = (ac.trackRad * 180) / Math.PI;
  let frame = makeRunwayFrame(ap, inUse.primary);
  if (inUse.all.length > 1) {
    let bestCross = Infinity;
    for (const r of inUse.all) {
      const f = makeRunwayFrame(ap, r);
      const c = Math.abs(relativeTo(f, ac.geo, ac.altitudeMslM, trackDeg, s.rel).crossM);
      if (c < bestCross) { bestCross = c; frame = f; }
    }
  }
  relativeTo(frame, ac.geo, ac.altitudeMslM, trackDeg, s.rel);
  const side = patternSideFor(frame.ident, ctx.info.towered ? sideOf(s.rel) : 'left');
  return { frame, side, entry: choosePatternEntry(s.rel, side) };
}

/** "10 miles east" of a field (tower calls), or "… of <name>" (radar calls). */
function whereFrom(s: AtcSession, ap: Airport, ofName?: string): Spoken {
  if (!s.ac) return spoken('');
  const rb = rangeBearing(ap.position, s.ac.geo);
  return positionFrom(rb.nm, rb.bearingDeg, ofName);
}

// ───────────────────────────── Ground (towered) ─────────────────────────────

export function requestClearance(s: AtcSession, ctx: FieldCtx): void {
  const cld = ctx.info.clearance;
  if (!cld) return;
  const code = s.newSquawk();
  const maxAlt = Math.round((ctx.info.patternAltitudeFt + 2000) / 500) * 500;
  const dep = ctx.info.departure;
  s.pilotSays(cld, (cs) => pilot.clearanceRequest(cld, cs, s.callsign.type || 'VFR', s.heardLetter(ctx)));
  s.atcReplies(cld, (cs) => atc.clearance(cs, cld, maxAlt, dep, code), () => {
    s.squawk = code;
    s.clearanceReceived = true;
    s.expectReadback(cld, 'Read back VFR clearance', (cs) => readback.clearance(cs, maxAlt, dep, code));
  });
}

export function requestTaxi(s: AtcSession, ctx: FieldCtx, intent: DepartureIntent): void {
  const gnd = ctx.info.ground;
  const rwy = departureRunway(s, ctx);
  if (!gnd || !rwy) return;
  s.intent = intent;
  s.pilotSays(gnd, (cs) => pilot.taxiRequest(gnd, cs, s.heardLetter(ctx), intent));
  const remark = atc.weatherRemark(ctx.info.shortName, s.currentLetter(ctx), s.heardLetter(ctx), s.altimeterOf(ctx));
  s.atcReplies(gnd, (cs) => atc.taxi(cs, gnd, rwy.ident, remark), () => {
    s.runway = makeRunwayFrame(ctx.info.airport, rwy);
    s.setPhase('TAXI_CLEARED');
    s.expectReadback(gnd, `Read back: taxi to runway ${rwySpoken(rwy.ident).text}, hold short`, (cs) => readback.taxi(cs, rwy.ident));
  });
}

// ───────────────────────────── Tower (towered) ─────────────────────────────

export function readyForDeparture(s: AtcSession, ctx: FieldCtx): void {
  const twr = ctx.info.tower;
  const ref = s.runway?.ref ?? departureRunway(s, ctx);
  if (!twr || !ref) return;
  s.pilotSays(twr, (cs) => pilot.readyForDeparture(twr, cs, ref.ident, s.intent));
  const closedSide = s.intent === 'closed-traffic' ? patternSideFor(ref.ident, 'left') : null;
  s.atcReplies(twr, (cs) => atc.takeoff(cs, twr, s.windOf(ctx), ref.ident, closedSide), () => {
    s.runway = makeRunwayFrame(ctx.info.airport, ref);
    if (closedSide) s.side = closedSide;
    s.setPhase('CLEARED_TAKEOFF');
    s.expectReadback(twr, `Read back: runway ${rwySpoken(ref.ident).text}, cleared for takeoff`, (cs) => readback.takeoff(cs, ref.ident));
  });
}

export function cancelTakeoff(s: AtcSession, ctx: FieldCtx): void {
  const twr = ctx.info.tower, ref = s.runway?.ref;
  if (!ref) return;
  if (!twr) { s.setPhase('HOLDING_SHORT'); return; }
  s.pilotSays(twr, (cs) => pilot.unableTakeoff(twr, cs, ref.ident));
  s.atcReplies(twr, (cs) => atc.holdShort(cs, ref.ident), () => {
    s.setPhase('HOLDING_SHORT');
    s.expectReadback(twr, `Read back: hold short runway ${rwySpoken(ref.ident).text}`, (cs) => readback.holdShort(cs, ref.ident));
  });
}

export function requestFrequencyChange(s: AtcSession, ctx: FieldCtx): void {
  const twr = ctx.info.tower;
  if (!twr) return;
  s.pilotSays(twr, (cs) => pilot.requestFrequencyChange(twr, cs));
  s.atcReplies(twr, (cs) => atc.frequencyChange(cs), () => {
    s.setPhase('ENROUTE');
    s.expectReadback(twr, 'Acknowledge frequency change', (cs) => readback.goodDay(cs));
  });
}

export function requestClosedTraffic(s: AtcSession, ctx: FieldCtx): void {
  const twr = ctx.info.tower, ref = s.runway?.ref ?? departureRunway(s, ctx);
  if (!twr || !ref) return;
  const side = patternSideFor(ref.ident, s.side);
  s.pilotSays(twr, (cs) => pilot.requestClosedTraffic(twr, cs));
  s.atcReplies(twr, (cs) => atc.closedTraffic(cs, side, ref.ident), () => {
    s.intent = 'closed-traffic';
    s.side = side;
    s.runway = makeRunwayFrame(ctx.info.airport, ref);
    s.landingClearance = 'none';
    s.setPhase('PATTERN');
    s.expectReadback(twr, `Read back: ${side} closed traffic`, (cs) => readback.closedTraffic(cs, side, ref.ident));
  });
}

// ───────────────────────────── Radar (flight following) ─────────────────────────────

export function requestFlightFollowing(s: AtcSession, radar: FieldCtx): void {
  const fac = radar.info.departure ?? radar.info.approach;
  if (!fac || !s.ac) return;
  const code = s.newSquawk();
  const where = whereFrom(s, radar.info.airport, radar.info.shortName);
  s.pilotSays(fac, (cs) => pilot.flightFollowing(fac, cs, s.callsign.type || 'VFR', where, altFt(s)));
  s.atcReplies(fac, (cs) => atc.radarContact(cs, fac, code, where, s.altimeterOf(radar)), () => {
    s.flightFollowing = fac;
    s.squawk = code;
    s.expectReadback(fac, 'Read back squawk code', (cs) => readback.squawk(cs, code));
  });
}

export function cancelFlightFollowing(s: AtcSession): void {
  const fac = s.flightFollowing;
  if (!fac) return;
  s.pilotSays(fac, (cs) => pilot.cancelFlightFollowing(fac, cs));
  s.atcReplies(fac, (cs) => atc.radarTerminated(cs, null), () => {
    s.flightFollowing = null;
    s.squawk = 1200;
    s.expectReadback(fac, 'Acknowledge: squawk VFR', (cs) => readback.squawkVfr(cs, null));
  });
}

// ───────────────────────────── Arrival ─────────────────────────────

/** Choose a destination without calling anyone yet (menu: "prepare to land at …"). */
export function selectDestination(s: AtcSession, airport: Airport): void {
  s.field = s.fieldCtx(airport);
  s.inboundSuppressed = null;
  s.setPhase('INBOUND');
}

export function cancelInbound(s: AtcSession): void {
  if (s.field) s.inboundSuppressed = s.field.info.airport.icao;
  s.setPhase('ENROUTE');
}

export function callInbound(s: AtcSession, ctx: FieldCtx, intent: LandingIntent): void {
  const twr = ctx.info.tower;
  const plan = arrivalPlan(s, ctx);
  if (!twr || !plan) return;
  s.flightFollowing = null;
  const where = whereFrom(s, ctx.info.airport);
  s.pilotSays(twr, (cs) => pilot.inbound(twr, cs, where, altFt(s), intent, s.heardLetter(ctx)));
  const remark = atc.weatherRemark(ctx.info.shortName, s.currentLetter(ctx), s.heardLetter(ctx), s.altimeterOf(ctx));
  const { frame, side, entry } = plan;
  s.atcReplies(twr, (cs) => atc.patternEntry(cs, twr, entry, side, frame.ident, remark), () => {
    s.landingIntent = intent;
    s.runway = frame; s.side = side; s.entry = entry;
    s.landingClearance = 'none';
    s.squawk = 1200;
    s.setPhase('PATTERN');
    s.expectReadback(twr, `Read back: ${entryPhrase(entry, side, frame.ident).text}`, (cs) => readback.patternEntry(cs, entry, side, frame.ident));
  });
}

export function announceInbound(s: AtcSession, ctx: FieldCtx, intent: LandingIntent): void {
  const plan = arrivalPlan(s, ctx);
  if (!plan) return;
  const { frame, side, entry } = plan;
  const where = whereFrom(s, ctx.info.airport);
  s.announce(ctx.info.ctaf, (cs) => ctaf.inbound(ctx.info.ctaf, cs, ctx.info.shortName, where, altFt(s), entry, side, frame.ident, intent));
  s.landingIntent = intent;
  s.runway = frame; s.side = side; s.entry = entry;
  s.landingClearance = 'none';
  s.setPhase('PATTERN');
}

/** Inbound/landing range check used by the menu: within this the field counts as nearby, m. */
export const NEARBY_FIELD_M = 30 * NM;
