/**
 * Frame-rate independent smoothing primitives shared by all camera modes.
 *
 * - {@link expSmoothing}: first-order low-pass, `x += (target − x) · (1 − e^(−dt/τ))`.
 * - {@link SpringScalar} / {@link SpringVector3}: critically damped second-order spring with
 *   the exact per-step solution (stable for any dt). We parameterise it by `τ`, the lag with
 *   which it trails a ramp (constant-velocity) target: ω = 2/τ.
 */
import * as THREE from 'three';

/** Fraction of the remaining gap to close in `dt` for a first-order lag of time constant `tau`. */
export const expSmoothing = (dt: number, tau: number): number => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

/** Natural frequency of a critically damped spring whose ramp-tracking lag is `tau`. */
export const omegaFromTau = (tau: number): number => 2 / Math.max(1e-4, tau);

/** Shortest-arc angle blend (rad): moves `current` toward `target` by fraction k. */
export function smoothAngle(current: number, target: number, k: number): number {
  let d = (target - current) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return current + d * k;
}

/** Critically damped spring on a scalar. */
export class SpringScalar {
  x = 0;
  v = 0;
  /** @param omega natural frequency rad/s (see {@link omegaFromTau}) */
  constructor(public omega: number) {}

  reset(x: number, v = 0): void { this.x = x; this.v = v; }

  /** Advance toward `target` by `dt` (exact solution for a target fixed during the step). */
  update(target: number, dt: number): number {
    const w = this.omega;
    const d = this.x - target;
    const e = Math.exp(-w * dt);
    const c = this.v + w * d;
    this.x = target + (d + c * dt) * e;
    this.v = (this.v - w * c * dt) * e;
    return this.x;
  }
}

/** Critically damped spring on a Vector3 (component-wise, no allocations). */
export class SpringVector3 {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  constructor(public omega: number) {}

  reset(p: THREE.Vector3): void { this.pos.copy(p); this.vel.set(0, 0, 0); }

  update(target: THREE.Vector3, dt: number): THREE.Vector3 {
    const w = this.omega;
    const e = Math.exp(-w * dt);
    const p = this.pos, v = this.vel;
    let d = p.x - target.x, c = v.x + w * d;
    p.x = target.x + (d + c * dt) * e; v.x = (v.x - w * c * dt) * e;
    d = p.y - target.y; c = v.y + w * d;
    p.y = target.y + (d + c * dt) * e; v.y = (v.y - w * c * dt) * e;
    d = p.z - target.z; c = v.z + w * d;
    p.z = target.z + (d + c * dt) * e; v.z = (v.z - w * c * dt) * e;
    return p;
  }
}

/**
 * Damped second-order spring on a scalar with arbitrary damping ratio ζ (exact per-step
 * solution for a target held constant over the step, so it is frame-rate independent).
 * Used for the cockpit head model (ωn ≈ 6 rad/s, ζ ≈ 0.7: a slight overshoot reads as "head").
 */
export class DampedSpringScalar {
  x = 0;
  v = 0;
  constructor(public omega: number, public zeta: number) {}

  reset(x: number, v = 0): void { this.x = x; this.v = v; }

  update(target: number, dt: number): number {
    const w = this.omega, z = this.zeta;
    const d0 = this.x - target, v0 = this.v;
    if (!(dt > 0)) return this.x;
    if (Math.abs(z - 1) < 1e-6) {
      const e = Math.exp(-w * dt), c = v0 + w * d0;
      this.x = target + (d0 + c * dt) * e;
      this.v = (v0 - w * c * dt) * e;
    } else if (z < 1) {
      const a = z * w, wd = w * Math.sqrt(1 - z * z);
      const e = Math.exp(-a * dt), cs = Math.cos(wd * dt), sn = Math.sin(wd * dt);
      this.x = target + e * (d0 * cs + ((v0 + a * d0) / wd) * sn);
      this.v = e * (v0 * cs - ((w * w * d0 + a * v0) / wd) * sn);
    } else {
      const s = w * Math.sqrt(z * z - 1);
      const r1 = -z * w + s, r2 = -z * w - s;
      const c1 = (v0 - r2 * d0) / (r1 - r2), c2 = d0 - c1;
      const e1 = Math.exp(r1 * dt), e2 = Math.exp(r2 * dt);
      this.x = target + c1 * e1 + c2 * e2;
      this.v = r1 * c1 * e1 + r2 * c2 * e2;
    }
    return this.x;
  }
}

/**
 * Exponentially decaying rate (inertia after a drag is released): advances `rate` by `dt` with
 * time constant `tau` and returns the exact distance covered during the step, ∫ r·e^(−t/τ) dt.
 * Summed over any frame sequence the total coast is r₀·τ, independent of the frame rate.
 */
export function coastStep(rate: number, dt: number, tau: number): { distance: number; rate: number } {
  coastScratch.distance = 0; coastScratch.rate = 0;
  if (tau <= 0 || !(dt > 0)) { coastScratch.rate = tau <= 0 ? 0 : rate; return coastScratch; }
  const k = Math.exp(-dt / tau);
  coastScratch.distance = rate * tau * (1 - k);
  coastScratch.rate = rate * k;
  return coastScratch;
}
const coastScratch = { distance: 0, rate: 0 };
