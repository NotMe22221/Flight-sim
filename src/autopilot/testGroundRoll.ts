/**
 * Minimal take-off-roll plant for the assisted-take-off tests (test-only). Kinematic tricycle:
 * yaw rate follows (first-order lag) nosewheel steering V·tan(δ)/wheelbase plus rudder authority
 * ∝ V², a left-turning P-factor / torque tendency that fades with speed, and crosswind
 * weathervaning into the wind. Speed builds from throttle and decays with drag and brakes; above
 * the rotation speed the aircraft is airborne (onGround = false). Fills an `AircraftState` in place.
 */
import type { AircraftState, ControlInputs } from '../core/types';
import { clamp, wrapTwoPi } from '../core/math';
import { DEG, KT } from '../core/units';
import { makeAircraftState } from './testPlant';

export interface GroundRollConfig {
  wheelbaseM: number;
  /** nosewheel steering at full pedal, rad */
  steerMaxRad: number;
  /** yaw rate from full rudder per (m/s)² of speed, rad/s */
  rudderYawPerV2: number;
  /** yaw-rate lag, s */
  yawTauS: number;
  /** P-factor / torque yaw rate at full throttle and zero speed (negative = nose left), rad/s */
  pFactorRadS: number;
  /** speed at which the P-factor tendency has faded out, m/s */
  pFactorFadeMs: number;
  /** weathervane yaw rate per m/s of crosswind component (positive crosswind from the right) */
  weathervanePerMs: number;
  /** crosswind component from the right, m/s */
  crosswindMs: number;
  /** acceleration at full throttle, m/s²; drag coefficient (per m) ; braking deceleration, m/s² */
  accelMs2: number;
  dragPerM: number;
  brakeDecelMs2: number;
  /** lift-off speed, m/s */
  liftoffMs: number;
}

export const defaultGroundRollConfig = (): GroundRollConfig => ({
  wheelbaseM: 1.65,
  steerMaxRad: 10 * DEG,
  rudderYawPerV2: 0.0006,
  yawTauS: 0.25,
  pFactorRadS: -0.08,
  pFactorFadeMs: 35,
  weathervanePerMs: 0.004,
  crosswindMs: 0,
  accelMs2: 2.6,
  dragPerM: 0.0015,
  brakeDecelMs2: 4,
  liftoffMs: 55 * KT,
});

export class GroundRollPlant {
  readonly cfg: GroundRollConfig;
  readonly state: AircraftState = makeAircraftState();
  V = 0;
  psi = 0;
  r = 0;
  north = 0;
  east = 0;

  constructor(headingRad: number, cfg: Partial<GroundRollConfig> = {}) {
    this.cfg = { ...defaultGroundRollConfig(), ...cfg };
    this.psi = wrapTwoPi(headingRad);
    this.fill();
  }

  /** Lateral offset from the line through the start point along `courseRad` (+ = right), m. */
  crossTrack(courseRad: number): number {
    return -this.north * Math.sin(courseRad) + this.east * Math.cos(courseRad);
  }

  step(dt: number, u: ControlInputs): void {
    const c = this.cfg;
    const onGround = this.V < c.liftoffMs;
    const brake = u.parkingBrake ? 1 : clamp(Math.max(u.brakeLeft, u.brakeRight), 0, 1);
    const yaw = clamp(u.yaw, -1, 1);
    const thr = clamp(u.throttle, 0, 1);
    const accel = c.accelMs2 * thr - c.dragPerM * this.V * this.V - (onGround ? c.brakeDecelMs2 * brake : 0);
    this.V = Math.max(0, this.V + accel * dt);
    const steer = onGround ? (this.V * Math.tan(c.steerMaxRad * yaw)) / c.wheelbaseM : 0;
    const rudder = c.rudderYawPerV2 * this.V * this.V * yaw;
    const pf = c.pFactorRadS * thr * Math.max(0, 1 - this.V / c.pFactorFadeMs);
    const wv = this.V > 1 ? c.weathervanePerMs * c.crosswindMs : 0;
    const rCmd = this.V > 0.05 ? steer + rudder + pf + wv : 0;
    this.r += (rCmd - this.r) * (1 - Math.exp(-dt / c.yawTauS));
    this.psi = wrapTwoPi(this.psi + this.r * dt);
    this.north += this.V * Math.cos(this.psi) * dt;
    this.east += this.V * Math.sin(this.psi) * dt;
    this.state.t += dt;
    this.fill();
  }

  private fill(): void {
    const s = this.state;
    const onGround = this.V < this.cfg.liftoffMs;
    s.posNED[0] = this.north; s.posNED[1] = this.east; s.posNED[2] = onGround ? 0 : -1;
    s.euler[0] = 0; s.euler[1] = 0; s.euler[2] = this.psi;
    s.rates[0] = 0; s.rates[1] = 0; s.rates[2] = this.r;
    s.headingTrueRad = this.psi;
    s.headingMagRad = this.psi;
    s.trackRad = this.psi;
    s.groundSpeedMs = this.V;
    s.velNED[0] = this.V * Math.cos(this.psi); s.velNED[1] = this.V * Math.sin(this.psi); s.velNED[2] = 0;
    s.verticalSpeedMs = 0;
    s.onGround = onGround;
    s.aero.tas = this.V; s.aero.ias = this.V; s.aero.cas = this.V; s.aero.eas = this.V;
    s.aero.alpha = 0; s.aero.alphaDot = 0;
    s.aero.beta = 0; // no lateral aerodynamics in this plant (the airborne tests use TestPlant)
  }
}
