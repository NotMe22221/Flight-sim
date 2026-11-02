/**
 * Small, allocation-free signal helpers shared by the autopilot loops. All of them are
 * discretised exactly for a constant input over the step, so results do not depend on the
 * frame rate.
 */
import { clamp } from '../core/math';

/** Move `current` toward `target` by at most `ratePerS · dt`. */
export const slew = (current: number, target: number, ratePerS: number, dt: number): number => {
  const m = Math.abs(ratePerS) * dt;
  return clamp(target, current - m, current + m);
};

/** First-order low-pass filter y' = (x − y) / τ. */
export class LowPass {
  value: number;
  constructor(public tau: number, initial = 0) { this.value = initial; }
  reset(value = 0): void { this.value = value; }
  update(x: number, dt: number): number {
    if (this.tau <= 0 || !(dt > 0)) { this.value = x; return x; }
    const a = Math.exp(-dt / this.tau);
    this.value = a * this.value + (1 - a) * x;
    return this.value;
  }
}

/**
 * Washout (high-pass) filter: passes changes of the input and decays to zero for a constant
 * input with time constant τ. Transfer function τs / (τs + 1). Used by the yaw damper so that
 * the steady yaw rate of a coordinated turn is not opposed.
 */
export class Washout {
  value = 0;
  private prev = Number.NaN;
  constructor(public tau: number) {}
  reset(x0 = 0): void { this.value = 0; this.prev = x0; }
  update(x: number, dt: number): number {
    if (Number.isNaN(this.prev)) { this.prev = x; this.value = 0; return 0; }
    if (this.tau <= 0 || !(dt > 0)) { this.prev = x; this.value = 0; return 0; }
    const a = Math.exp(-dt / this.tau);
    this.value = a * (this.value + x - this.prev);
    this.prev = x;
    return this.value;
  }
}

/** Filtered numerical differentiator: d/dt(x) passed through a low-pass of time constant τ. */
export class Differentiator {
  value = 0;
  private prev = Number.NaN;
  constructor(public tau: number) {}
  reset(): void { this.value = 0; this.prev = Number.NaN; }
  update(x: number, dt: number): number {
    if (!(dt > 0)) return this.value;
    const raw = Number.isNaN(this.prev) ? 0 : (x - this.prev) / dt;
    this.prev = x;
    if (this.tau <= 0) { this.value = raw; return raw; }
    const a = Math.exp(-dt / this.tau);
    this.value = a * this.value + (1 - a) * raw;
    return this.value;
  }
}

/** Rate limiter with memory (slews its stored value toward the target). */
export class RateLimiter {
  value: number;
  constructor(public ratePerS: number, initial = 0) { this.value = initial; }
  reset(value: number): void { this.value = value; }
  update(target: number, dt: number): number {
    this.value = slew(this.value, target, this.ratePerS, dt);
    return this.value;
  }
}
