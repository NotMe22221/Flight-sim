/**
 * Small signal filters used by the instrument dynamics. All are allocation-free and stable for
 * any dt (exponential coefficients rather than Euler steps).
 */
import { deltaDeg, wrap360 } from '../core/math';

/** First-order low-pass: dy/dt = (x − y)/τ. τ ≤ 0 passes the input through. */
export class Lag {
  value: number;
  constructor(public tau: number, initial = 0) { this.value = initial; }
  step(target: number, dt: number): number {
    if (this.tau <= 0 || dt <= 0) { if (this.tau <= 0) this.value = target; return this.value; }
    const a = 1 - Math.exp(-dt / this.tau);
    this.value += (target - this.value) * a;
    return this.value;
  }
  reset(v: number): void { this.value = v; }
}

/** First-order low-pass on a heading-like angle in degrees (wraps across 360). */
export class LagAngleDeg {
  value: number;
  constructor(public tau: number, initial = 0) { this.value = wrap360(initial); }
  step(targetDeg: number, dt: number): number {
    if (this.tau <= 0 || dt <= 0) { if (this.tau <= 0) this.value = wrap360(targetDeg); return this.value; }
    const a = 1 - Math.exp(-dt / this.tau);
    this.value = wrap360(this.value + deltaDeg(targetDeg, this.value) * a);
    return this.value;
  }
  reset(v: number): void { this.value = wrap360(v); }
}

/** Low-pass with different time constants for rising and falling inputs (oil temperature). */
export class AsymmetricLag {
  value: number;
  constructor(public tauUp: number, public tauDown: number, initial = 0) { this.value = initial; }
  step(target: number, dt: number): number {
    const tau = target > this.value ? this.tauUp : this.tauDown;
    if (tau <= 0 || dt <= 0) { if (tau <= 0) this.value = target; return this.value; }
    this.value += (target - this.value) * (1 - Math.exp(-dt / tau));
    return this.value;
  }
  reset(v: number): void { this.value = v; }
}

/** Filtered time derivative of a signal (trend vectors). */
export class Derivative {
  private last = NaN;
  readonly lag: Lag;
  constructor(tau: number) { this.lag = new Lag(tau, 0); }
  /** Returns the filtered rate d(value)/dt. */
  step(value: number, dt: number): number {
    if (Number.isNaN(this.last) || dt <= 0) { this.last = value; return this.lag.value; }
    const raw = (value - this.last) / dt;
    this.last = value;
    return this.lag.step(raw, dt);
  }
  reset(value: number): void { this.last = value; this.lag.reset(0); }
}

/** Latches `true` only after the condition has held continuously for `holdS` seconds. */
export class HoldTimer {
  private held = 0;
  constructor(public holdS: number) {}
  step(condition: boolean, dt: number): boolean {
    this.held = condition ? this.held + dt : 0;
    return condition && this.held >= this.holdS;
  }
  reset(): void { this.held = 0; }
}
