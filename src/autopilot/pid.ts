/**
 * Discrete PID controller used by every autopilot loop (servo inner loops and the
 * VS / FLC outer loops).
 *
 * Properties:
 *  - Derivative acts on the *measurement* (or on a measured rate that the caller supplies,
 *    e.g. the body roll rate for the roll loop), so a setpoint step produces no derivative kick.
 *  - Output saturation with two anti-windup mechanisms: conditional integration (the integral
 *    is not advanced while the output is saturated in the direction the error pushes) and
 *    back-calculation with time constant `tt` (the integral is bled toward the value that puts
 *    the output exactly at the limit). The integral contribution is also clamped to ±iLim.
 *  - Bumpless transfer: `resetToOutput` sets the integral so that the next update yields a
 *    chosen output (the pilot's current stick position, the current pitch attitude, ...).
 *  - Frame-rate independent: integration uses dt, the derivative filter uses exp(-dt/τ).
 *
 * Gains may be negative (the FLC loop maps "too fast" to "pitch up"); the anti-windup logic
 * reasons about the sign of the integral *increment*, not of the error.
 */
import { clamp } from '../core/math';

export interface PidConfig {
  /** proportional gain, output units per error unit */
  kp: number;
  /** integral gain, output units per (error unit · s) */
  ki: number;
  /** derivative gain on the measurement, output units per (error unit / s); positive damps */
  kd: number;
  /** output saturation */
  outMin: number;
  outMax: number;
  /** absolute limit of the integral term's contribution (output units); default (outMax − outMin) / 2 */
  iLim?: number;
  /** back-calculation anti-windup time constant, s (0 disables; conditional integration still applies) */
  tt?: number;
  /** first-order filter time constant for the numerical derivative, s (0 = unfiltered) */
  tauD?: number;
}

export class Pid {
  kp: number;
  ki: number;
  kd: number;
  outMin: number;
  outMax: number;
  iLim: number;
  tt: number;
  tauD: number;
  /** integral term contribution, output units */
  integral = 0;
  /** last saturated output */
  output = 0;
  /** last output before saturation (for diagnostics / tests) */
  outputUnsat = 0;
  /** multiplier applied to kp and kd (gain scheduling); 1 = nominal */
  gainScale = 1;
  private prevMeas = Number.NaN;
  private dFilt = 0;

  constructor(cfg: PidConfig) {
    this.kp = cfg.kp;
    this.ki = cfg.ki;
    this.kd = cfg.kd;
    this.outMin = cfg.outMin;
    this.outMax = cfg.outMax;
    this.iLim = cfg.iLim ?? (cfg.outMax - cfg.outMin) / 2;
    this.tt = cfg.tt ?? 0;
    this.tauD = cfg.tauD ?? 0;
  }

  /** Change the saturation limits (e.g. FLC pitch limits that depend on climb/descend direction). */
  setOutputLimits(lo: number, hi: number): void {
    this.outMin = Math.min(lo, hi);
    this.outMax = Math.max(lo, hi);
  }

  /** Clear all state (integral, derivative memory, output). */
  reset(): void {
    this.integral = 0;
    this.output = 0;
    this.outputUnsat = 0;
    this.prevMeas = Number.NaN;
    this.dFilt = 0;
  }

  /**
   * Bumpless transfer: set the integral so that an update with these inputs yields `output`.
   * `measurementRate` must be the same signal the caller will pass to `update` (or omitted
   * for both). The result is also clamped to the output limits.
   */
  resetToOutput(output: number, setpoint: number, measurement: number, measurementRate = 0): number {
    const e = setpoint - measurement;
    const p = this.kp * this.gainScale * e;
    const d = -this.kd * this.gainScale * measurementRate;
    this.prevMeas = measurement;
    this.dFilt = measurementRate;
    this.integral = clamp(output - p - d, -this.iLim, this.iLim);
    this.outputUnsat = p + this.integral + d;
    this.output = clamp(this.outputUnsat, this.outMin, this.outMax);
    return this.output;
  }

  /**
   * Advance the controller by dt seconds.
   * @param setpoint desired value
   * @param measurement measured value
   * @param dt step, s (must be > 0)
   * @param measurementRate optional measured d(measurement)/dt; when omitted a filtered
   *        numerical derivative of the measurement is used
   */
  update(setpoint: number, measurement: number, dt: number, measurementRate?: number): number {
    if (!(dt > 0)) return this.output;
    const e = setpoint - measurement;
    const gs = this.gainScale;

    let dm: number;
    if (measurementRate !== undefined) dm = measurementRate;
    else dm = Number.isNaN(this.prevMeas) ? 0 : (measurement - this.prevMeas) / dt;
    this.prevMeas = measurement;
    if (this.tauD > 0) {
      const a = Math.exp(-dt / this.tauD);
      this.dFilt = a * this.dFilt + (1 - a) * dm;
      dm = this.dFilt;
    } else this.dFilt = dm;

    const p = this.kp * gs * e;
    const d = -this.kd * gs * dm;
    const inc = this.ki * e * dt;

    let i = clamp(this.integral + inc, -this.iLim, this.iLim);
    let u = p + i + d;
    const uSat = clamp(u, this.outMin, this.outMax);
    if (u !== uSat) {
      // Conditional integration: discard the increment if it pushes further into saturation.
      if ((u > this.outMax && inc > 0) || (u < this.outMin && inc < 0)) i = this.integral;
      // Back-calculation: bleed the integral toward the value that puts the output at the limit.
      if (this.tt > 0) {
        const uNow = p + i + d;
        const uNowSat = clamp(uNow, this.outMin, this.outMax);
        i += ((uNowSat - uNow) * dt) / this.tt;
      }
      i = clamp(i, -this.iLim, this.iLim);
      u = p + i + d;
    }
    this.integral = i;
    this.outputUnsat = u;
    this.output = clamp(u, this.outMin, this.outMax);
    return this.output;
  }
}
