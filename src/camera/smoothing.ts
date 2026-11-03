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
