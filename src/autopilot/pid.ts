/**
 * Discrete PID controller used by every autopilot loop (servo inner loops and the
 * VS / FLC outer loops).
 *
 * Properties:
 *  - Derivative acts on the *measurement* (or on a measured rate that the caller supplies,
 *    e.g. the body roll rate for the roll loop), so a setpoint step produces no derivative kick.
 *  - Output saturation with anti-windup:
 *      1. conditional integration — while the output is saturated, an integral increment that
 *         would push further into saturation is discarded (the integral keeps the load it carried);
 *      2. back-calculation of the integral term with time constant `tt` — when the integral term
 *         *by itself* lies outside [outMin, outMax] (the limits moved, e.g. FLC direction limits) it
 *         is bled exponentially back to the limit. Unlike textbook back-calculation on the whole
 *         output, this never drags the integral the "wrong" way while a large P term saturates the
 *         output, so there is no reverse windup when the error clears;
 *      3. the integral contribution is clamped to ±iLim.
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
  /** back-calculation time constant for an integral term outside the output limits, s (0 = clamp at once) */
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
    if (this.tauD > 0) {
      const a = Math.exp(-dt / this.tauD);
      dm = a * this.dFilt + (1 - a) * dm;
    }

    const p = this.kp * gs * e;
    const d = -this.kd * gs * dm;
    const inc = this.ki * e * dt;

    let i = this.integral + inc;
    const uTry = p + i + d;
    // 1. conditional integration: integrate only up to the point where the output reaches the
    //    limit, and never pull the integral back because the P/D terms saturate on their own
    if (uTry > this.outMax && inc > 0) i = Math.max(this.integral, this.outMax - p - d);
    else if (uTry < this.outMin && inc < 0) i = Math.min(this.integral, this.outMin - p - d);
    // 2. back-calculation of an integral term that lies outside the output range by itself
    if (i > this.outMax || i < this.outMin) {
      const lim = i > this.outMax ? this.outMax : this.outMin;
      i = this.tt > 0 ? lim + (i - lim) * Math.exp(-dt / this.tt) : lim;
    }
    // 3. integral authority
    i = clamp(i, -this.iLim, this.iLim);
    const u = p + i + d;
    // A non-finite input (NaN target, garbage air data) must not latch the integral or the
    // derivative memory — clamp() passes NaN through. Hold the last output instead.
    if (!Number.isFinite(u)) return this.output;
    this.prevMeas = measurement;
    this.dFilt = dm;
    this.integral = i;
    this.outputUnsat = u;
    this.output = clamp(u, this.outMin, this.outMax);
    return this.output;
  }
}
