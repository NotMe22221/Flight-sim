/**
 * Pilot actions in the traffic pattern, after landing, and the CTAF self-announcements of
 * untowered fields (no replies; the state changes immediately).
 */
import { FT } from '../core/units';
import { departureRunway } from './actions';
import { patternSideFor, type RunwayRef } from './field';
import { makeRunwayFrame, rangeBearing } from './geometry';
import { atc, ctaf, pilot, readback } from './messages';
import { runway as rwySpoken, spoken } from './phraseology';
import type { AtcSession, FieldCtx } from './session';
import type { DepartureIntent, LandingIntent } from './types';

const altFt = (s: AtcSession): number => (s.ac ? s.ac.altitudeMslM / FT : 0);

/**
 * Cancel the landing clearance after a go-around / touch-and-go / pattern exit. The next
 * clearance is held back until the aircraft has flown a lateral leg (`flags.armed`), so a
 * go-around on final is not immediately re-cleared.
 */
export function resetApproach(s: AtcSession): void {
  s.landingClearance = 'none';
  s.flags.minHeightM = Infinity;
  s.flags.climbS = 0;
  s.flags.armed = false;
}

/** Record the landing clearance just given (reply or unsolicited) and ask for its readback. */
export function landingClearanceText(s: AtcSession, ctx: FieldCtx): void {
  const twr = ctx.info.tower, frame = s.runway;
  if (!twr || !frame) return;
  const kind = s.landingIntent === 'touch-and-go' ? 'touch-and-go' : 'land';
  s.landingClearance = kind;
  s.flags.minHeightM = Infinity;
  s.flags.climbS = 0;
  s.expectReadback(twr, `Read back: runway ${rwySpoken(frame.ident).text}, ${kind === 'land' ? 'cleared to land' : 'cleared touch and go'}`,
    (cs) => readback.landing(cs, frame.ident, kind));
}

// ───────────────────────────── Towered pattern ─────────────────────────────

export function reportPosition(s: AtcSession, ctx: FieldCtx): void {
  const twr = ctx.info.tower, frame = s.runway;
  if (!twr || !frame) return;
  const leg = s.leg === 'outside' ? 'downwind' : s.leg;
  s.pilotSays(twr, (cs) => pilot.positionReport(twr, cs, leg, s.side, frame.ident));
  if (leg === 'final' && s.landingClearance === 'none') {
    const kind = s.landingIntent === 'touch-and-go' ? 'touch-and-go' : 'land';
    s.atcReplies(twr, (cs) => atc.landing(cs, s.windOf(ctx), frame.ident, kind), () => landingClearanceText(s, ctx));
    return;
  }
  const next = leg === 'downwind' ? spoken('base') : leg === 'base' ? spoken('final') : null;
  s.atcReplies(twr, (cs) => atc.roger(cs, s.landingClearance === 'none' ? next : null));
}

export function requestOption(s: AtcSession, ctx: FieldCtx, intent: LandingIntent): void {
  const twr = ctx.info.tower, frame = s.runway;
  if (!twr || !frame) return;
  s.pilotSays(twr, (cs) => pilot.requestOption(twr, cs, intent));
  if (s.landingClearance !== 'none') {
    const kind = intent === 'touch-and-go' ? 'touch-and-go' : 'land';
    s.atcReplies(twr, (cs) => atc.landing(cs, s.windOf(ctx), frame.ident, kind), () => {
      s.landingIntent = intent;
      landingClearanceText(s, ctx);
    });
    return;
  }
  s.atcReplies(twr, (cs) => atc.optionAck(cs, intent), () => { s.landingIntent = intent; });
}

export function goingAround(s: AtcSession, ctx: FieldCtx): void {
  const frame = s.runway;
  if (!frame) return;
  const twr = ctx.info.tower;
  resetApproach(s);
  if (!twr) {
    s.announce(ctx.info.ctaf, (cs) => ctaf.goingAround(ctx.info.ctaf, cs, ctx.info.shortName, frame.ident));
    return;
  }
  const side = s.side;
  s.pilotSays(twr, (cs) => pilot.goingAround(twr, cs));
  s.atcReplies(twr, (cs) => atc.goAroundAck(cs, side, frame.ident), () => {
    s.expectReadback(twr, `Read back: ${side} traffic`, (cs) => readback.traffic(cs, side));
  });
}

export function leavePattern(s: AtcSession, ctx: FieldCtx): void {
  const twr = ctx.info.tower;
  if (!twr) { announceLeavingArea(s, ctx); return; }
  s.pilotSays(twr, (cs) => pilot.requestFrequencyChange(twr, cs));
  s.atcReplies(twr, (cs) => atc.frequencyChange(cs), () => {
    resetApproach(s);
    s.intent = 'departure'; // no longer in closed traffic
    s.setPhase('ENROUTE');
    s.expectReadback(twr, 'Acknowledge frequency change', (cs) => readback.goodDay(cs));
  });
}

export function clearOfRunway(s: AtcSession, ctx: FieldCtx): void {
  const frame = s.runway;
  const ident = frame?.ident ?? '';
  const gnd = ctx.info.ground;
  if (!gnd) {
    if (ident) s.announce(ctx.info.ctaf, (cs) => ctaf.clear(ctx.info.ctaf, cs, ctx.info.shortName, ident));
    s.setPhase('TAXI_IN');
    return;
  }
  s.pilotSays(gnd, (cs) => pilot.clearOfRunway(gnd, cs, ident));
  s.atcReplies(gnd, (cs) => atc.taxiToParking(cs, gnd), () => {
    s.setPhase('TAXI_IN');
    s.expectReadback(gnd, 'Read back: taxi to parking', (cs) => readback.taxiToParking(cs));
  });
}

// ───────────────────────────── CTAF self-announcements ─────────────────────────────

/** `runway`: the end named in the option (defaults to the in-use parallel nearest the aircraft). */
export function announceTaxi(s: AtcSession, ctx: FieldCtx, intent: DepartureIntent, runway: RunwayRef | null = null): void {
  const ref = runway ?? departureRunway(s, ctx);
  if (!ref) return;
  s.intent = intent;
  s.runway = makeRunwayFrame(ctx.info.airport, ref);
  s.announce(ctx.info.ctaf, (cs) => ctaf.taxi(ctx.info.ctaf, cs, ctx.info.shortName, ref.ident, intent));
  s.setPhase('TAXI_CLEARED');
}

export function announceDeparture(s: AtcSession, ctx: FieldCtx): void {
  const ref = s.runway?.ref ?? departureRunway(s, ctx);
  if (!ref) return;
  s.runway = makeRunwayFrame(ctx.info.airport, ref);
  s.side = patternSideFor(ref.ident, 'left');
  s.announce(ctx.info.ctaf, (cs) => ctaf.departing(ctx.info.ctaf, cs, ctx.info.shortName, ref.ident, s.intent));
  s.setPhase('CLEARED_TAKEOFF');
}

export function announceLeavingArea(s: AtcSession, ctx: FieldCtx): void {
  if (s.ac) {
    const brg = rangeBearing(ctx.info.airport.position, s.ac.geo).bearingDeg;
    s.announce(ctx.info.ctaf, (cs) => ctaf.leavingArea(ctx.info.ctaf, cs, ctx.info.shortName, brg, altFt(s)));
  }
  resetApproach(s);
  s.intent = 'departure'; // no longer in closed traffic
  s.setPhase('ENROUTE');
}

export function announceRemainInPattern(s: AtcSession, ctx: FieldCtx): void {
  const frame = s.runway;
  if (!frame) return;
  s.intent = 'closed-traffic';
  s.side = patternSideFor(frame.ident, 'left');
  s.announce(ctx.info.ctaf, (cs) => ctaf.leg(ctx.info.ctaf, cs, ctx.info.shortName, 'upwind', s.side, frame.ident));
  resetApproach(s);
  s.setPhase('PATTERN');
}

export function announceLeg(s: AtcSession, ctx: FieldCtx): void {
  const frame = s.runway;
  if (!frame || s.leg === 'outside') return;
  const leg = s.leg;
  s.announce(ctx.info.ctaf, (cs) => ctaf.leg(ctx.info.ctaf, cs, ctx.info.shortName, leg, s.side, frame.ident));
}
