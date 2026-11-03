/**
 * Discrete actions → the pilot's `ControlInputs` (flaps, gear, brakes, levers, trims,
 * magnetos, lights, heats, spoilers). Pure functions over a ControlInputs object so the
 * same code path serves keys, buttons, touch and UI clicks.
 */
import type { ControlInputs } from '../core/types';
import { clamp } from '../core/math';
import type { BindableAction } from './actions';

/** Step sizes and rates for keyboard/button driven controls (tuning knobs). */
export interface ControlRates {
  /** throttle change per throttleInc/Dec event (default 0.05 = 5 %) */
  throttleStep: number;
  /** throttle change per throttleIncSmall/DecSmall event (default 0.01) */
  throttleStepSmall: number;
  /** mixture change per mixtureInc/Dec event (default 0.05) */
  mixtureStep: number;
  /** propeller lever change per propellerInc/Dec event (default 0.05) */
  propellerStep: number;
  /** elevator trim change per trim event, of the −1..1 range (default 0.01; ≈0.1/s held, 0.2/s after 1 s) */
  pitchTrimStep: number;
  rudderTrimStep: number;
  aileronTrimStep: number;
  /** brakesHold: seconds to full braking (default 0.25) */
  brakeRampTime: number;
  /** brakesHold: seconds to release (default 0.15) */
  brakeReleaseTime: number;
  /** lever rate when keys are bound directly to a lever axis, per s (default 0.5) */
  leverKeyRate: number;
}

export const DEFAULT_CONTROL_RATES: Readonly<ControlRates> = {
  throttleStep: 0.05, throttleStepSmall: 0.01, mixtureStep: 0.05, propellerStep: 0.05,
  pitchTrimStep: 0.01, rudderTrimStep: 0.01, aileronTrimStep: 0.01,
  brakeRampTime: 0.25, brakeReleaseTime: 0.15, leverKeyRate: 0.5,
};

export type LeverAxis = 'throttle' | 'mixture' | 'propeller';

export interface MapperContext {
  /** number of flap detents of the current aircraft (flapsIndex is clamped to 0..n−1) */
  flapDetents: number;
  rates: ControlRates;
  /** false while an analog lever owns the axis: keyboard increments are ignored (§B7 step 5) */
  leverFree(axis: LeverAxis): boolean;
}

/** Rounds stepped values so 20 × 5 % is exactly 1. */
const q = (v: number): number => Math.round(v * 1e6) / 1e6;

function stepLever(c: ControlInputs, axis: LeverAxis, delta: number, ctx: MapperContext): void {
  if (!ctx.leverFree(axis)) return;
  c[axis] = clamp(q(c[axis] + delta), 0, 1);
}

function setLever(c: ControlInputs, axis: LeverAxis, v: number, ctx: MapperContext): void {
  if (!ctx.leverFree(axis)) return;
  c[axis] = v;
}

const trim = (v: number, d: number): number => clamp(q(v + d), -1, 1);

/**
 * Applies one action. Returns true if the action belongs to the pilot controls (including
 * level actions such as brakesHold/starter, whose effect is applied by the manager each
 * poll), false for simulator-level actions (camera, autopilot, time, ATC …).
 */
export function applyControlAction(c: ControlInputs, a: BindableAction, ctx: MapperContext): boolean {
  const r = ctx.rates;
  const maxFlap = Math.max(0, Math.floor(ctx.flapDetents) - 1);
  switch (a) {
    case 'flapsUp': c.flapsIndex = clamp(c.flapsIndex - 1, 0, maxFlap); return true;
    case 'flapsDown': c.flapsIndex = clamp(c.flapsIndex + 1, 0, maxFlap); return true;
    case 'flapsFull': c.flapsIndex = maxFlap; return true;
    case 'flapsRetract': c.flapsIndex = 0; return true;
    case 'gearToggle': c.gearDown = !c.gearDown; return true;
    case 'gearUp': c.gearDown = false; return true;
    case 'gearDown': c.gearDown = true; return true;
    case 'parkingBrakeToggle': c.parkingBrake = !c.parkingBrake; return true;
    case 'brakesHold': case 'starter': return true; // levels, applied per poll
    case 'throttleCut': setLever(c, 'throttle', 0, ctx); return true;
    case 'throttleFull': setLever(c, 'throttle', 1, ctx); return true;
    case 'throttleInc': stepLever(c, 'throttle', r.throttleStep, ctx); return true;
    case 'throttleDec': stepLever(c, 'throttle', -r.throttleStep, ctx); return true;
    case 'throttleIncSmall': stepLever(c, 'throttle', r.throttleStepSmall, ctx); return true;
    case 'throttleDecSmall': stepLever(c, 'throttle', -r.throttleStepSmall, ctx); return true;
    case 'mixtureRich': setLever(c, 'mixture', 1, ctx); return true;
    case 'mixtureLean': setLever(c, 'mixture', 0, ctx); return true;
    case 'mixtureInc': stepLever(c, 'mixture', r.mixtureStep, ctx); return true;
    case 'mixtureDec': stepLever(c, 'mixture', -r.mixtureStep, ctx); return true;
    case 'propellerLow': setLever(c, 'propeller', 0, ctx); return true;
    case 'propellerHigh': setLever(c, 'propeller', 1, ctx); return true;
    case 'propellerInc': stepLever(c, 'propeller', r.propellerStep, ctx); return true;
    case 'propellerDec': stepLever(c, 'propeller', -r.propellerStep, ctx); return true;
    case 'trimNoseUp': c.pitchTrim = trim(c.pitchTrim, r.pitchTrimStep); return true;
    case 'trimNoseDown': c.pitchTrim = trim(c.pitchTrim, -r.pitchTrimStep); return true;
    case 'rudderTrimLeft': c.rudderTrim = trim(c.rudderTrim, -r.rudderTrimStep); return true;
    case 'rudderTrimRight': c.rudderTrim = trim(c.rudderTrim, r.rudderTrimStep); return true;
    case 'aileronTrimLeft': c.aileronTrim = trim(c.aileronTrim, -r.aileronTrimStep); return true;
    case 'aileronTrimRight': c.aileronTrim = trim(c.aileronTrim, r.aileronTrimStep); return true;
    case 'magnetosNext': c.magnetos = ((c.magnetos + 1) % 4) as ControlInputs['magnetos']; return true;
    case 'magnetosPrev': c.magnetos = ((c.magnetos + 3) % 4) as ControlInputs['magnetos']; return true;
    case 'lightsNav': c.lights.nav = !c.lights.nav; return true;
    case 'lightsBeacon': c.lights.beacon = !c.lights.beacon; return true;
    case 'lightsStrobe': c.lights.strobe = !c.lights.strobe; return true;
    case 'lightsLanding': c.lights.landing = !c.lights.landing; return true;
    case 'lightsTaxi': c.lights.taxi = !c.lights.taxi; return true;
    case 'lightsPanel': c.lights.panel = c.lights.panel > 0 ? 0 : 1; return true;
    case 'lightsAll': {
      const l = c.lights;
      const on = !(l.nav && l.beacon && l.strobe && l.landing && l.taxi);
      l.nav = on; l.beacon = on; l.strobe = on; l.landing = on; l.taxi = on;
      return true;
    }
    case 'pitotHeat': c.pitotHeat = !c.pitotHeat; return true;
    case 'carbHeat': c.carbHeat = !c.carbHeat; return true;
    // electrical switches: undefined means on (master, avionics) / off (fuel pump), as in ControlInputs
    case 'masterToggle': {
      const on = !((c.masterBattery ?? true) && (c.masterAlternator ?? true));
      c.masterBattery = on; c.masterAlternator = on;
      return true;
    }
    case 'masterBatteryToggle': {
      const on = !(c.masterBattery ?? true);
      c.masterBattery = on;
      if (!on) c.masterAlternator = false; // the split rocker's ALT half cannot stay on without BAT
      return true;
    }
    case 'masterAlternatorToggle': {
      const on = !(c.masterAlternator ?? true);
      c.masterAlternator = on;
      if (on) c.masterBattery = true; // ALT on pushes BAT on
      return true;
    }
    case 'avionicsMasterToggle': c.avionicsMaster = !(c.avionicsMaster ?? true); return true;
    case 'fuelPumpToggle': c.fuelPump = !(c.fuelPump ?? false); return true;
    case 'spoilersToggle': c.speedbrake = c.speedbrake > 0 ? 0 : 1; return true;
    default: return false;
  }
}

/**
 * Moves a value toward a target at fixed rates (s for a full 0→1 / 1→0 travel).
 * Used for the brakesHold ramp. Returns the new value.
 */
export function rampToward(v: number, target: number, dt: number, upTime: number, downTime: number): number {
  if (v < target) return Math.min(target, v + dt / Math.max(1e-3, upTime));
  if (v > target) return Math.max(target, v - dt / Math.max(1e-3, downTime));
  return v;
}
