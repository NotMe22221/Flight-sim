/**
 * Gyro instrument dynamics: spin-up/spin-down, erection error of the vacuum attitude indicator,
 * precession drift of the directional gyro and the electric turn coordinator's rate gyro.
 * Behaviour follows the constants in docs/research/05 §1.2 (FlightGear-derived; reimplemented).
 */
import { clamp, deltaDeg, gaussian, mulberry32, wrap360 } from '../core/math';
import { RAD } from '../core/units';
import { Lag } from './filters';

/** Rotor speed model: linear spin-up to the available power, slow run-down when power is lost. */
export class GyroSpin {
  /** 0..1 fraction of rated rotor speed */
  spin = 0;
  constructor(public spinUpS = 4, public spinDownS = 180) {}
  /** `power` is the fraction of rated drive (suction / 4.5 inHg, or 1 when the electrical bus is live). */
  step(power: number, dt: number): number {
    const target = clamp(power, 0, 1);
    if (target > this.spin) this.spin = Math.min(target, this.spin + dt / this.spinUpS);
    else this.spin = Math.max(target, this.spin - dt / this.spinDownS);
    return this.spin;
  }
  reset(spin: number): void { this.spin = clamp(spin, 0, 1); }
}

/** Follow-rate coefficient: the indication tracks truth at 100·s⁶ per second (fast at full spin, frozen when dead). */
const followAlpha = (spin: number, dt: number): number => 1 - Math.exp(-dt * 100 * spin ** 6);

export interface AttitudeGyroConfig {
  maxRollErrDeg: number;
  maxPitchErrDeg: number;
  /** precession accumulated per degree of roll travel (deg/deg) */
  precessionPerDeg: number;
  /** decay of accumulated precession, deg/min */
  precessionDecayDegPerMin: number;
}

/** Vacuum attitude indicator with erection error below 80 % spin and roll-induced precession. */
export class AttitudeGyro {
  readonly gyro = new GyroSpin(4, 180);
  /** indicated values (deg) */
  pitchDeg = 0;
  rollDeg = 0;
  caged = false;
  private fRoll = 0;
  private fPitch = 0;
  private precessionDeg = 0;

  constructor(public cfg: AttitudeGyroConfig = { maxRollErrDeg: 40, maxPitchErrDeg: 12, precessionPerDeg: 0.02, precessionDecayDegPerMin: 3 }) {}

  step(truePitchDeg: number, trueRollDeg: number, rollRateRadS: number, power: number, dt: number): void {
    const s = this.gyro.step(power, dt);
    const a = followAlpha(s, dt);
    this.fRoll = wrap180(this.fRoll + deltaDeg(trueRollDeg, this.fRoll) * a);
    this.fPitch += (truePitchDeg - this.fPitch) * a;
    this.precessionDeg += this.cfg.precessionPerDeg * Math.abs(rollRateRadS * RAD) * dt;
    this.precessionDeg = Math.max(0, this.precessionDeg - (this.cfg.precessionDecayDegPerMin / 60) * dt);
    const e = s < 0.8 ? ((0.8 - s) / 0.8) ** 2 : 0;
    if (this.caged) { this.rollDeg = 0; this.pitchDeg = 0; return; }
    this.rollDeg = wrap180(this.fRoll + e * this.cfg.maxRollErrDeg + this.precessionDeg);
    this.pitchDeg = this.fPitch + e * this.cfg.maxPitchErrDeg;
  }

  /** True when the rotor is fast enough for a usable indication (GYRO flag otherwise). */
  get valid(): boolean { return this.gyro.spin > 0.5; }

  reset(pitchDeg: number, rollDeg: number, spin = 1): void {
    this.gyro.reset(spin); this.fPitch = this.pitchDeg = pitchDeg; this.fRoll = this.rollDeg = rollDeg; this.precessionDeg = 0;
  }
}

const wrap180 = (d: number): number => deltaDeg(d, 0);

export interface HeadingGyroConfig {
  /** apparent drift from earth rotation + bearing friction, deg/min */
  driftDegPerMin: number;
  /** random-walk standard deviation, deg per √minute (0 = deterministic drift only) */
  randomWalkDegPerSqrtMin: number;
  seed: number;
}

/** Vacuum directional gyro: tracks heading through a spin-dependent lag and accumulates drift. */
export class HeadingGyro {
  readonly gyro = new GyroSpin(4, 180);
  /** indicated heading deg (0..360) */
  headingDeg = 0;
  /** accumulated drift offset deg (reset by `align`) */
  offsetDeg = 0;
  private filtered = 0;
  private rnd: () => number;

  constructor(public cfg: HeadingGyroConfig = { driftDegPerMin: 0.25, randomWalkDegPerSqrtMin: 0.3, seed: 1234 }) {
    this.rnd = mulberry32(cfg.seed);
  }

  step(referenceHeadingDeg: number, power: number, driftEnabled: boolean, dt: number): number {
    const s = this.gyro.step(power, dt);
    const a = followAlpha(s, dt);
    this.filtered = wrap360(this.filtered + deltaDeg(referenceHeadingDeg, this.filtered) * a);
    if (driftEnabled && s > 0.1 && dt > 0) {
      this.offsetDeg += (this.cfg.driftDegPerMin / 60) * dt;
      if (this.cfg.randomWalkDegPerSqrtMin > 0) this.offsetDeg += gaussian(this.rnd) * this.cfg.randomWalkDegPerSqrtMin * Math.sqrt(dt / 60);
    }
    this.headingDeg = wrap360(this.filtered + this.offsetDeg);
    return this.headingDeg;
  }

  /** Pilot presses the knob: the card is set to `headingDeg` (normally the magnetic compass reading). */
  align(headingDeg: number): void { this.offsetDeg = deltaDeg(headingDeg, this.filtered); this.headingDeg = wrap360(headingDeg); }

  get valid(): boolean { return this.gyro.spin > 0.5; }

  reset(headingDeg: number, spin = 1): void {
    this.gyro.reset(spin); this.filtered = wrap360(headingDeg); this.offsetDeg = 0; this.headingDeg = this.filtered; this.rnd = mulberry32(this.cfg.seed);
  }
}

/**
 * Turn-coordinator rate in standard-rate units (1.0 = 3°/s): a blend of yaw rate and roll rate
 * (the TC gyro is canted 30° so it responds to roll-in), clamped to ±2.5.
 */
export function turnRateStd(pRadS: number, rRadS: number): number {
  return clamp((pRadS * RAD) / 20 + (rRadS * RAD) / 3, -2.5, 2.5);
}

/** Electric turn coordinator: rate gyro with dashpot damping; shows a flag without electrical power. */
export class TurnGyro {
  readonly gyro = new GyroSpin(4, 180);
  readonly lag: Lag;
  /** indicated rate in standard-rate units */
  rateStd = 0;
  constructor(tauS = 1.0) { this.lag = new Lag(tauS, 0); }
  step(pRadS: number, rRadS: number, powered: boolean, dt: number): number {
    const s = this.gyro.step(powered ? 1 : 0, dt);
    const factor = 1 - (1 - s) ** 3;
    this.rateStd = this.lag.step(turnRateStd(pRadS, rRadS) * factor, dt);
    return this.rateStd;
  }
  get valid(): boolean { return this.gyro.spin > 0.5; }
  reset(spin = 1): void { this.gyro.reset(spin); this.lag.reset(0); this.rateStd = 0; }
}

/**
 * Inclinometer ball displacement in ball-widths from the body specific force in g
 * (`ny` + right, `nz` + up as in `AircraftState.loadFactor`). Positive = ball right.
 * 4° of apparent-gravity tilt per ball width.
 */
export function ballWidths(ny: number, nz: number, degPerBall = 4): number {
  const ang = Math.atan2(-ny, Math.max(nz, 0.05)) * RAD;
  return clamp(ang / degPerBall, -1.5, 1.5);
}
