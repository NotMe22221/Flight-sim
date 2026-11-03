/** Predicates that auto-tick checklist items when the sim state already matches. Pure. */
import type { SimSnapshot } from '../../core/types';
import type { AutoCheckId } from '../data/c172Checklists';

const KT = 1.943844492;
const FT = 0.3048;

export const AUTO_CHECKS: Record<AutoCheckId, (s: SimSnapshot) => boolean> = {
  parkingBrakeSet: (s) => s.inputs.parkingBrake,
  parkingBrakeReleased: (s) => !s.inputs.parkingBrake,
  brakesApplied: (s) => s.inputs.brakeLeft > 0.3 && s.inputs.brakeRight > 0.3,
  magnetosBoth: (s) => s.inputs.magnetos === 3,
  magnetosOff: (s) => s.inputs.magnetos === 0,
  engineRunning: (s) => s.aircraft.engine.running,
  engineOff: (s) => !s.aircraft.engine.running,
  oilPressureOk: (s) => s.aircraft.engine.running && s.aircraft.engine.oilPressurePa > 170_000, // > ~25 psi
  mixtureRich: (s) => s.inputs.mixture > 0.95,
  mixtureCutoff: (s) => s.inputs.mixture < 0.05,
  mixtureLeaned: (s) => s.inputs.mixture < 0.9 && s.inputs.mixture > 0.2,
  throttleIdle: (s) => s.inputs.throttle < 0.05,
  throttleQuarter: (s) => s.inputs.throttle > 0.05 && s.inputs.throttle < 0.35,
  throttleFull: (s) => s.inputs.throttle > 0.95,
  throttleRunup: (s) => s.aircraft.engine.running && s.aircraft.engine.rpm >= 1700 && s.aircraft.engine.rpm <= 1900,
  throttleLow: (s) => s.aircraft.engine.running && s.aircraft.engine.rpm <= 1050,
  fuelBoth: (s) => s.inputs.fuelSelector === 'both',
  fuelLeftOrRight: (s) => s.inputs.fuelSelector === 'left' || s.inputs.fuelSelector === 'right',
  flapsUp: (s) => s.inputs.flapsIndex === 0,
  flaps10: (s) => s.inputs.flapsIndex === 1,
  flapsTakeoff: (s) => s.inputs.flapsIndex <= 1,
  flapsFull: (s) => s.inputs.flapsIndex >= 3,
  flaps20orLess: (s) => s.inputs.flapsIndex <= 2,
  beaconOn: (s) => s.inputs.lights.beacon,
  navLightsOn: (s) => s.inputs.lights.nav,
  strobeOn: (s) => s.inputs.lights.strobe,
  strobeOff: (s) => !s.inputs.lights.strobe,
  landingLightOn: (s) => s.inputs.lights.landing,
  landingLightOff: (s) => !s.inputs.lights.landing,
  taxiLightOn: (s) => s.inputs.lights.taxi,
  autopilotOff: (s) => !s.autopilot.engaged,
  trimTakeoff: (s) => Math.abs(s.inputs.pitchTrim) < 0.15,
  airborne: (s) => !s.aircraft.onGround,
  onGround: (s) => s.aircraft.onGround,
  climbSpeed: (s) => { const kt = s.aircraft.aero.ias * KT; return !s.aircraft.onGround && kt >= 68 && kt <= 86 && s.aircraft.verticalSpeedMs > 0.5; },
  altimeterSet: (s) => Math.abs(s.aircraft.qnhSetPa - s.weather.qnhPa) < 50, // within 0.5 hPa
  pitotHeatOn: (s) => s.inputs.pitotHeat,
  // electrical switches: undefined = ON (flight models without an electrical system)
  masterOn: (s) => s.inputs.masterBattery !== false && s.inputs.masterAlternator !== false,
  masterOff: (s) => s.inputs.masterBattery === false && s.inputs.masterAlternator === false,
  avionicsOn: (s) => s.inputs.avionicsMaster !== false,
  avionicsOff: (s) => s.inputs.avionicsMaster === false,
  carbHeatOn: (s) => s.inputs.carbHeat,
  carbHeatOff: (s) => !s.inputs.carbHeat,
  flapsSecondNotch: (s) => s.inputs.flapsIndex >= 2,
  cubClimbSpeed: (s) => { const kt = s.aircraft.aero.ias * KT; return !s.aircraft.onGround && kt >= 55 && kt <= 72 && s.aircraft.verticalSpeedMs > 0.5; },
};

export const AUTO_CHECK_IDS = Object.keys(AUTO_CHECKS) as AutoCheckId[];

/** Safe evaluation (a half-built snapshot must never break the panel). */
export function evalAutoCheck(id: AutoCheckId, s: SimSnapshot | null | undefined): boolean {
  if (!s) return false;
  try { return AUTO_CHECKS[id](s); } catch { return false; }
}

export const _unitsForTests = { KT, FT };
