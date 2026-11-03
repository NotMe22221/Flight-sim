/**
 * What each G1000 display shows, folded into a `Signature` at display resolution, so `G1000`
 * can skip redraws (and texture uploads) while the picture would not change — parked, or in a
 * steady autopilot cruise. Quanta are roughly half a pixel of the corresponding moving element.
 */
import type { NavRadioState, SimSnapshot } from '../../core/types';
import type { InstrumentReadings } from '../readings';
import type { Signature } from '../signature';
import { ALERT_DEFS } from './alerts';
import type { MfdState } from './mfd';
import type { BearingState } from './navData';
import type { PfdState } from './pfd';

function navRadio(h: Signature, n: NavRadioState): void {
  h.num(n.activeKHz).num(n.standbyKHz).bool(n.valid).str(n.ident).num(n.dmeNm, 0.1)
    .bool(n.gsValid).num(n.gsDeviation, 0.005).bool(n.isLocalizer).num(n.obsDeg, 0.5)
    .str(n.marker ?? null).bool(n.backCourse === true).bool(n.dmeValid !== false);
}

function bearing(h: Signature, b: BearingState): void {
  h.str(b.source).bool(b.valid).num(b.bearingDeg, 0.5).num(b.distanceNm, 0.1).str(b.ident);
}

/** Hash of everything the PFD draws. */
export function pfdSignature(h: Signature, s: SimSnapshot, r: InstrumentReadings, st: PfdState): number {
  h.reset().bool(r.avionicsOn).bool(r.ahrs.valid).bool(r.onGround);
  h.num(r.ahrs.pitchDeg, 0.1).num(r.ahrs.rollDeg, 0.1).num(r.turn.ballWidths, 0.02);
  h.num(r.iasKt, 0.05).num(r.tasKt, 1).num(r.gsKt, 1).num(r.trends.iasKtPer6s, 0.5);
  h.num(r.altimeter.indicatedFt, 0.5).num(r.altimeter.settingInHg, 0.005).num(r.trends.altFtPer6s, 5).num(r.adcVsFpm, 5);
  // magnetic variation converts the plan's true bearings for the nav status box
  h.num(r.heading.magDeg, 0.1).num(r.heading.bugDeg, 0.5).num(r.trends.headingDegPer6s, 0.2).num(r.heading.magVarDeg, 0.1);
  h.num(r.wind.fromMagDeg, 1).num(r.wind.speedKt, 1).num(r.wind.headwindKt, 1).num(r.wind.crosswindKt, 1);
  h.num(r.oatC, 1).num(r.clock.utcMs, 1000).num(r.clock.timerS, 1);
  for (const d of ALERT_DEFS) h.bool(r.annunciators[d.key]);
  const c = st.cdi;
  h.str(c.label).bool(c.valid).num(c.courseDeg, 0.5).num(c.deviation, 0.004).str(c.toFrom).str(c.scaleLabel).str(c.ident).num(c.distanceNm, 0.1);
  bearing(h, st.brg1); bearing(h, st.brg2);
  const ap = s.autopilot;
  h.bool(ap.engaged).bool(ap.flightDirector).bool(ap.yawDamper).str(ap.lateral).str(ap.vertical).str(ap.armedLateral).str(ap.armedVertical);
  h.num(ap.altitudeTargetM, 1).num(ap.verticalSpeedTargetMs, 0.1).num(ap.iasTargetMs, 0.2).num(ap.fdPitchRad, 0.002).num(ap.fdRollRad, 0.002);
  const f = st.afcs;
  const flashing = f.lateralFlashS > 0 || f.verticalFlashS > 0 || f.disconnectFlashS > 0;
  h.bool(f.lateralFlashS > 0).bool(f.verticalFlashS > 0).bool(f.disconnectFlashS > 0).bool(flashing && f.blinkOn);
  navRadio(h, s.nav1); navRadio(h, s.nav2);
  const plan = s.plan;
  if (plan) {
    h.num(plan.activeLeg).num(plan.distanceToActiveM, 50).num(plan.bearingToActiveDeg, 1).num(plan.eteS, 1);
    const to = plan.waypoints[plan.activeLeg], from = plan.waypoints[plan.activeLeg - 1];
    h.str(to ? to.id : null).str(from ? from.id : null);
  } else h.bool(false);
  h.num(st.com1.activeKHz).num(st.com1.standbyKHz).num(st.com2.activeKHz).num(st.com2.standbyKHz);
  h.num(st.squawk).str(st.xpdrMode).num(st.windOption).str(st.dmeSource).str(st.cdiSource);
  return h.value;
}

/** Hash of everything the MFD draws; `version` changes whenever a setter changed map content. */
export function mfdSignature(h: Signature, s: SimSnapshot, r: InstrumentReadings, st: MfdState, pxPerNm: number, version: number): number {
  const ac = s.aircraft, e = r.engine;
  h.reset().bool(r.avionicsOn).num(version);
  h.num(e.rpm, 5).num(e.fuelFlowGph, 0.1).num(e.oilPressPsi, 1).num(e.oilTempF, 1).num(e.egtF, 1);
  h.num(r.suctionInHg, 0.1).num(r.fuelGal[0], 0.1).num(r.fuelGal[1], 0.1).num(r.tachHours, 0.1).num(r.voltsV, 0.1).num(r.batteryAmpsA, 1).bool(r.annunciators.lowVolts);
  // half a map pixel of movement, in degrees of latitude
  const q = 0.5 / (Math.max(pxPerNm, 1e-6) * 60);
  h.num(ac.geo.lat, q).num(ac.geo.lon, q).num(ac.headingTrueRad, 0.003).num(ac.trackRad, 0.003).num(r.gsKt, 1);
  h.num(r.wind.fromTrueDeg, 1).num(r.wind.speedKt, 1).num(r.heading.trackMagDeg, 1).num(r.heading.magVarDeg, 0.1);
  h.num(st.rangeNm, 0.001).str(st.orientation).str(st.cdiSource);
  const plan = s.plan;
  if (plan) {
    h.num(plan.activeLeg).num(plan.waypoints.length).num(plan.desiredTrackDeg, 0.5).num(plan.eteS, 1);
    for (const w of plan.waypoints) h.str(w.id).str(w.type).num(w.position.lat, 1e-4).num(w.position.lon, 1e-4);
  } else h.bool(false);
  h.num(s.nav1.activeKHz).num(s.nav1.standbyKHz).str(s.nav1.ident).bool(s.nav1.valid);
  h.num(s.nav2.activeKHz).num(s.nav2.standbyKHz).str(s.nav2.ident).bool(s.nav2.valid);
  h.num(st.com1.activeKHz).num(st.com1.standbyKHz).num(st.com2.activeKHz).num(st.com2.standbyKHz);
  return h.value;
}
