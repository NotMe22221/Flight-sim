/**
 * Automatic detection that drives the state machine between pilot selections: liftoff and
 * touchdown, holding short, departure handoff, inbound detection, pattern legs, landing
 * clearance on final, go-around, runway exit and parking. Every unsolicited controller call is
 * guarded by a flag or a state change so it is made once, never every frame.
 */
import { NM, RAD } from '../core/units';
import { allRunwayRefs } from './field';
import { greatCircleDistance } from '../geo/wgs84';
import {
  classifyPatternLeg, isAtHoldShort, isEstablishedOnFinal, makeRelativeState, makeRunwayFrame, relativeTo,
  type RunwayFrame,
} from './geometry';
import { atc, readback } from './messages';
import { frequency } from './phraseology';
import { landingClearanceText, resetApproach } from './patternActions';
import type { AtcSession, FieldCtx } from './session';
import type { AtcPhase } from './types';

/** Debounce for liftoff (continuous time off the ground), s. */
const LIFTOFF_S = 1.0;
/** Debounce for touchdown (continuous time on the ground), s. */
const TOUCHDOWN_S = 0.3;
/** Stopped this long near a runway end → holding short, s. */
const HOLD_SHORT_STOP_S = 2;
/** Stopped with the engine off this long → parked, s. */
const PARK_ENGINE_OFF_S = 3;
/** Stopped (engine running) this long after landing → parked, s. */
const PARK_IDLE_S = 60;
/** Continuous closing time on a towered field before INBOUND, s. */
const INBOUND_CLOSING_S = 3;
/** Closing speed that counts as "heading for it", m/s. */
const INBOUND_CLOSING_MS = 10;
/** Time outside the pattern area before reverting to en route, s. */
const PATTERN_EXIT_S = 10;

const GROUND_PHASES: ReadonlySet<AtcPhase> = new Set(['PARKED', 'TAXI_CLEARED', 'HOLDING_SHORT', 'CLEARED_TAKEOFF', 'LANDED', 'TAXI_IN']);
const scratchRel = makeRelativeState();

/** Watch state for automatic INBOUND detection. */
export interface InboundWatch { icao: string; lastRangeM: number; closingS: number }

/** Kinematic timers and debounced airborne state; returns the liftoff/touchdown edge, if any. */
export function updateKinematics(s: AtcSession, dt: number, airborne: { value: boolean }): 'liftoff' | 'touchdown' | null {
  const ac = s.ac;
  if (!ac) return null;
  s.flags.timeS += dt;
  s.stoppedS = ac.onGround && ac.groundSpeedMs < s.tuning.stoppedSpeedMs ? s.stoppedS + dt : 0;
  if (ac.onGround) { s.groundS += dt; s.airborneS = 0; } else { s.airborneS += dt; s.groundS = 0; }
  if (!airborne.value && s.airborneS >= LIFTOFF_S) { airborne.value = true; return 'liftoff'; }
  if (airborne.value && s.groundS >= TOUCHDOWN_S) { airborne.value = false; return 'touchdown'; }
  return null;
}

/** Refresh the aircraft position relative to the operation's runway and the pattern leg. */
export function updateRunwayGeometry(s: AtcSession): void {
  const ac = s.ac, rw = s.runway;
  if (!ac || !rw) return;
  relativeTo(rw, ac.geo, ac.altitudeMslM, ac.trackRad * RAD, s.rel);
  if (s.phase !== 'PATTERN') return;
  const leg = classifyPatternLeg(s.rel, rw.lengthM, s.side);
  if (leg !== s.leg) { s.leg = leg; s.menuDirty = true; }
  // A new approach can be cleared once the aircraft has flown a lateral leg (or left the pattern).
  if (!s.flags.armed && (leg === 'crosswind' || leg === 'downwind' || leg === 'base' || leg === 'outside')) {
    s.flags.armed = true;
    s.menuDirty = true;
  }
  if (leg !== 'outside') s.flags.joined = true;
}

/** The runway end best matching the aircraft's position and track (for liftoff/landing without clearance). */
export function runwayUnderAircraft(s: AtcSession, ctx: FieldCtx): RunwayFrame | null {
  const ac = s.ac;
  if (!ac) return null;
  let best: RunwayFrame | null = null, bestScore = Infinity;
  for (const ref of allRunwayRefs(ctx.info.airport)) {
    const f = makeRunwayFrame(ctx.info.airport, ref);
    const rel = relativeTo(f, ac.geo, ac.altitudeMslM, ac.trackRad * RAD, scratchRel);
    if (Math.abs(rel.relTrackDeg) > 45 || rel.alongM < -500 || rel.alongM > f.lengthM + 2000 || Math.abs(rel.crossM) > 300) continue;
    const score = Math.abs(rel.crossM) + Math.abs(rel.relTrackDeg) * 5;
    if (score < bestScore) { bestScore = score; best = f; }
  }
  return best;
}

/** Nearest airport within `maxNm` as a field context, or null. */
export function nearestField(s: AtcSession, maxNm: number): FieldCtx | null {
  if (!s.ac) return null;
  const near = s.nav.nearestAirports(s.ac.geo, 1, maxNm);
  return near.length ? s.fieldCtx(near[0]) : null;
}

/** Handle a liftoff or touchdown edge. */
export function onEdge(s: AtcSession, edge: 'liftoff' | 'touchdown'): void {
  if (edge === 'liftoff') {
    if (s.phase === 'PATTERN') {
      if (s.flags.touchedDown) { s.flags.touchedDown = false; resetApproach(s); }
      return;
    }
    if (!GROUND_PHASES.has(s.phase)) return;
    if (!s.field) s.field = nearestField(s, 3);
    if (s.field && (!s.runway || s.phase !== 'CLEARED_TAKEOFF')) s.runway = runwayUnderAircraft(s, s.field) ?? s.runway;
    if (s.intent === 'closed-traffic' && s.runway && s.field) {
      resetApproach(s);
      s.setPhase('PATTERN');
    } else s.setPhase('DEPARTING');
    return;
  }
  // touchdown
  if (GROUND_PHASES.has(s.phase)) return;
  if (s.phase === 'PATTERN' && s.field) {
    const tng = s.landingClearance === 'touch-and-go' || (!s.field.info.towered && s.landingIntent === 'touch-and-go');
    if (tng) { s.flags.touchedDown = true; return; }
  }
  // Landed at the current airport if on one of its runways, else at the nearest airport.
  let ctx = s.field;
  let rw = ctx ? runwayUnderAircraft(s, ctx) : null;
  if (!rw) {
    const near = nearestField(s, 3);
    if (near && near !== ctx) { ctx = near; rw = runwayUnderAircraft(s, near); }
  }
  if (ctx !== s.field) s.runway = rw;
  else if (rw) s.runway = rw;
  s.field = ctx;
  s.setPhase(ctx ? 'LANDED' : 'TAXI_IN');
}

/**
 * Runway end whose hold-short area the aircraft is in (the assigned runway preferred, then any
 * end of the field), or null. Allocates; call on events (stop, start), not every frame.
 */
export function holdShortRunwayAt(s: AtcSession): RunwayFrame | null {
  const ctx = s.field, ac = s.ac;
  if (!ctx || !ac) return null;
  const track = ac.headingTrueRad * RAD;
  const candidates: RunwayFrame[] = s.runway ? [s.runway] : [];
  for (const ref of allRunwayRefs(ctx.info.airport)) candidates.push(makeRunwayFrame(ctx.info.airport, ref));
  let best: RunwayFrame | null = null, bestD = Infinity;
  for (const f of candidates) {
    const rel = relativeTo(f, ac.geo, ac.altitudeMslM, track, scratchRel);
    if (!isAtHoldShort(rel)) continue;
    const d = Math.hypot(rel.alongM, rel.crossM) - (f === s.runway ? 200 : 0); // prefer the assigned runway
    if (d < bestD) { bestD = d; best = f; }
  }
  return best;
}

/** Stopped near a runway end → HOLDING_SHORT (checked once per stop). */
function checkHoldShort(s: AtcSession, dt: number): void {
  if (s.stoppedS < HOLD_SHORT_STOP_S || s.stoppedS - dt >= HOLD_SHORT_STOP_S) return;
  const best = holdShortRunwayAt(s);
  if (!best) return;
  s.runway = best;
  s.setPhase('HOLDING_SHORT');
}

function monitorDeparture(s: AtcSession): void {
  const ctx = s.field, ac = s.ac;
  if (!ctx || !ac) { s.setPhase('ENROUTE'); return; }
  const dist = greatCircleDistance(ctx.info.airport.position, ac.geo);
  const height = ac.altitudeMslM - ctx.info.airport.elevationM;
  if (dist < s.tuning.handoffDistanceM && height < s.tuning.handoffHeightM) return;
  const twr = ctx.info.tower;
  if (twr && s.facility === twr) {
    if (s.radio.busy) return;
    const dep = ctx.info.departure;
    if (dep) {
      s.atcCalls(twr, (cs) => atc.handoff(cs, dep));
      s.expectReadback(twr, `Read back: contact ${dep.name.text} ${frequency(dep.mhz).text}`, (cs) => readback.handoff(cs, dep), () => s.tune(dep));
    } else {
      s.atcCalls(twr, (cs) => atc.frequencyChange(cs));
      s.expectReadback(twr, 'Acknowledge frequency change', (cs) => readback.goodDay(cs));
    }
  }
  s.setPhase('ENROUTE');
}

function monitorEnroute(s: AtcSession, watch: InboundWatch, tickS: number): void {
  const ac = s.ac;
  if (!ac) return;
  s.menuDirty = true; // nearby-airport options follow the aircraft (emitted only when the labels change)
  const near = s.nav.nearestAirports(ac.geo, 8, s.tuning.inboundCancelRangeM / NM);
  if (s.inboundSuppressed && !near.some((a) => a.icao === s.inboundSuppressed)) s.inboundSuppressed = null;
  let target: FieldCtx | null = null, rangeM = Infinity;
  for (const ap of near) {
    if (ap.icao === s.inboundSuppressed) continue;
    const r = greatCircleDistance(ap.position, ac.geo);
    if (r > s.tuning.inboundRangeM) continue;
    const ctx = s.peekField(ap);
    if (!ctx.info.towered) continue;
    if (r < rangeM) { rangeM = r; target = ctx; }
  }
  if (!target) { watch.icao = ''; watch.closingS = 0; return; }
  const icao = target.info.airport.icao;
  if (watch.icao !== icao) { watch.icao = icao; watch.lastRangeM = rangeM; watch.closingS = 0; return; }
  const closing = (watch.lastRangeM - rangeM) / Math.max(tickS, 1e-3);
  watch.lastRangeM = rangeM;
  watch.closingS = closing > INBOUND_CLOSING_MS ? watch.closingS + tickS : 0;
  if (watch.closingS < INBOUND_CLOSING_S || s.radio.busy) return;
  const ff = s.flightFollowing;
  const twr = target.info.tower;
  if (ff && twr) {
    s.atcCalls(ff, (cs) => atc.radarTerminated(cs, twr));
    s.expectReadback(ff, `Acknowledge: squawk VFR, contact ${twr.name.text}`, (cs) => readback.squawkVfr(cs, twr), () => s.tune(twr));
    s.flightFollowing = null;
    s.squawk = 1200;
  }
  s.field = s.fieldCtx(target.info.airport);
  watch.icao = ''; watch.closingS = 0;
  s.setPhase('INBOUND');
}

function monitorInbound(s: AtcSession): void {
  const ctx = s.field, ac = s.ac;
  if (!ctx || !ac) { s.setPhase('ENROUTE'); return; }
  if (greatCircleDistance(ctx.info.airport.position, ac.geo) > s.tuning.inboundCancelRangeM) {
    s.field = null;
    s.setPhase('ENROUTE');
  }
}

function monitorPattern(s: AtcSession, dt: number): void {
  const ctx = s.field, ac = s.ac, rw = s.runway;
  if (!ctx || !ac || !rw) { s.setPhase('ENROUTE'); return; }
  const twr = ctx.info.tower;
  // Leaving the pattern area (an arrival still on its way in is not "leaving").
  const range = greatCircleDistance(ctx.info.airport.position, ac.geo);
  const left = s.flags.joined ? range > s.tuning.patternExitRangeM : range > s.tuning.inboundCancelRangeM;
  s.flags.outsideS = s.leg === 'outside' && left ? s.flags.outsideS + dt : 0;
  if (s.flags.outsideS >= PATTERN_EXIT_S) {
    if (twr && s.facility === twr) {
      if (s.radio.busy) return;
      s.atcCalls(twr, (cs) => atc.frequencyChange(cs));
      s.expectReadback(twr, 'Acknowledge frequency change', (cs) => readback.goodDay(cs));
    }
    resetApproach(s);
    s.setPhase('ENROUTE');
    return;
  }
  // A touch-and-go that stops on the runway became a full-stop landing.
  if (s.flags.touchedDown && ac.onGround && ac.groundSpeedMs < s.tuning.exitRunwaySpeedMs) { s.setPhase('LANDED'); return; }
  if (!twr || ac.onGround || s.flags.touchedDown) return;
  const height = s.rel.heightM;
  // Landing clearance once established on final.
  if (s.landingClearance === 'none') {
    if (s.flags.armed && !s.radio.busy && isEstablishedOnFinal(s.rel, s.tuning.landingClearanceRangeM)) {
      const kind = s.landingIntent === 'touch-and-go' ? 'touch-and-go' : 'land';
      s.atcCalls(twr, (cs) => atc.landing(cs, s.windOf(ctx), rw.ident, kind));
      landingClearanceText(s, ctx);
    }
    return;
  }
  // Go-around: climbing away from final low, after the landing clearance.
  if (height < s.tuning.goAroundMaxHeightM) s.flags.minHeightM = Math.min(s.flags.minHeightM, height);
  s.flags.climbS = ac.verticalSpeedMs > s.tuning.goAroundClimbMs ? s.flags.climbS + dt : 0;
  const climbedAway = height > s.flags.minHeightM + 10 && s.flags.minHeightM < s.tuning.goAroundMaxHeightM;
  if (s.flags.climbS >= 1.5 && climbedAway && height < s.tuning.goAroundMaxHeightM && !s.radio.busy) {
    const alt = ctx.info.patternAltitudeFt, side = s.side;
    s.atcCalls(twr, (cs) => atc.goAround(cs, alt, side, rw.ident));
    resetApproach(s);
    s.expectReadback(twr, 'Read back go-around instructions', (cs) => readback.goAround(cs, alt));
  }
}

function monitorLanded(s: AtcSession): void {
  const ctx = s.field, ac = s.ac;
  if (!ctx || !ac) return;
  const twr = ctx.info.tower, gnd = ctx.info.ground;
  if (twr && gnd && !s.flags.callIssued && ac.groundSpeedMs < s.tuning.exitRunwaySpeedMs && !s.radio.busy) {
    s.flags.callIssued = true;
    s.atcCalls(twr, (cs) => atc.exitRunway(cs, gnd));
    s.expectReadback(twr, `Read back: exit runway, contact Ground ${frequency(gnd.mhz).text}`, (cs) => readback.exitRunway(cs, gnd), () => s.tune(gnd));
  }
  if (s.stoppedS >= PARK_ENGINE_OFF_S && !ac.engine.running) parkHere(s);
}

function monitorTaxiIn(s: AtcSession): void {
  const ac = s.ac;
  if (!ac) return;
  if ((s.stoppedS >= PARK_ENGINE_OFF_S && !ac.engine.running) || s.stoppedS >= PARK_IDLE_S) parkHere(s);
}

/** Arrived at parking: ready for the next departure from this field. */
function parkHere(s: AtcSession): void {
  s.intent = 'departure';
  s.landingIntent = 'full-stop';
  s.landingClearance = 'none';
  s.clearanceReceived = false;
  s.flightFollowing = null;
  s.squawk = 1200;
  s.runway = null;
  s.entry = null;
  s.pendingReadback = null;
  s.setPhase('PARKED');
}

/** Per-frame phase monitors. `slowTickS` > 0 on the 1 Hz ticks (its value is the tick length). */
export function monitorPhase(s: AtcSession, dt: number, slowTickS: number, watch: InboundWatch): void {
  switch (s.phase) {
    case 'PARKED':
    case 'TAXI_CLEARED':
      if (!s.field && slowTickS > 0 && s.ac?.onGround) { // nav data may load after the start
        s.field = nearestField(s, 3);
        if (s.field) s.menuDirty = true;
      }
      checkHoldShort(s, dt);
      break;
    case 'DEPARTING':
      monitorDeparture(s);
      break;
    case 'ENROUTE':
      if (slowTickS > 0) monitorEnroute(s, watch, slowTickS);
      break;
    case 'INBOUND':
      if (slowTickS > 0) monitorInbound(s);
      break;
    case 'PATTERN':
      monitorPattern(s, dt);
      break;
    case 'LANDED':
      monitorLanded(s);
      break;
    case 'TAXI_IN':
      monitorTaxiIn(s);
      break;
    default:
      break;
  }
}
