/**
 * Wet (whiskey) magnetic compass: the float aligns with the local field vector including dip, so a
 * banked or accelerating float shows the classic northerly-turning and acceleration errors; the
 * card has an under-damped second-order response that overshoots after roll-out.
 */
import { clamp, deltaDeg, wrap360 } from '../core/math';
import { DEG, RAD } from '../core/units';

export interface CompassConfig {
  /** magnetic dip angle, deg (≈ 61° at KSFO) */
  dipDeg: number;
  /** float tilt per g of longitudinal acceleration, rad */
  accelTiltRadPerG: number;
  /** card natural frequency rad/s and damping ratio */
  omega: number;
  zeta: number;
  /** amplitude of the deviation card error, deg */
  deviationDeg: number;
}

export const defaultCompassConfig = (): CompassConfig => ({ dipDeg: 61, accelTiltRadPerG: 0.35, omega: 1.6, zeta: 0.45, deviationDeg: 2 });

/**
 * Heading a free magnet shows when its float is tilted `floatRollRad` / `floatPitchRad` relative to
 * the horizontal while the aircraft heads `headingMagDeg`, in a field with dip `dipRad`.
 */
export function compassTargetDeg(headingMagDeg: number, floatRollRad: number, floatPitchRad: number, dipRad: number): number {
  const psi = headingMagDeg * DEG, phi = floatRollRad, th = floatPitchRad, mu = dipRad;
  const a = Math.cos(phi) * Math.sin(psi) * Math.cos(mu) - Math.sin(phi) * Math.cos(th) * Math.sin(mu) - Math.sin(phi) * Math.sin(th) * Math.cos(mu) * Math.cos(psi);
  const b = Math.cos(th) * Math.cos(psi) * Math.cos(mu) - Math.sin(th) * Math.sin(mu);
  return wrap360(Math.atan2(a, b) * RAD);
}

/** Compass deviation card residual (after swinging): a small two-cycle error. */
export function deviationDeg(headingMagDeg: number, amplitudeDeg: number): number {
  const h = headingMagDeg * DEG;
  return amplitudeDeg * (0.6 * Math.sin(h) - 0.4 * Math.cos(2 * h));
}

export class MagneticCompass {
  /** indicated heading deg 0..360 */
  headingDeg = 0;
  private rateDegS = 0;
  constructor(public cfg: CompassConfig = defaultCompassConfig()) {}

  /**
   * @param headingMagDeg true-magnetic heading of the aircraft
   * @param rollRad aircraft bank
   * @param ballRad apparent-gravity tilt in the lateral plane (0 when coordinated) — the float hangs along apparent gravity, so float roll = bank − ball angle
   * @param longAccelG inertial acceleration along the flight path in g (speed change), tilts the float
   */
  step(headingMagDeg: number, rollRad: number, ballRad: number, longAccelG: number, dt: number): number {
    const floatRoll = rollRad - ballRad;
    // The pendulous float lags behind when the aircraft accelerates: it hangs along apparent
    // gravity, i.e. pitched nose-DOWN (θ −= k·a_x/g, docs/research/05 §1.2). With dip this gives
    // the "ANDS" error: accelerate → north, decelerate → south on E/W headings (north. hemisphere).
    const floatPitch = -clamp(longAccelG, -1, 1) * this.cfg.accelTiltRadPerG;
    const target = compassTargetDeg(headingMagDeg, floatRoll, floatPitch, this.cfg.dipDeg * DEG) + deviationDeg(headingMagDeg, this.cfg.deviationDeg);
    if (!Number.isFinite(target)) return this.headingDeg; // skip a bad sample rather than latch NaN
    // Under-damped second-order card response, semi-implicit Euler with sub-stepping for stability.
    let remaining = Math.max(0, dt);
    const { omega, zeta } = this.cfg;
    while (remaining > 1e-6) {
      const h = Math.min(remaining, 0.05);
      const err = deltaDeg(target, this.headingDeg);
      this.rateDegS += (omega * omega * err - 2 * zeta * omega * this.rateDegS) * h;
      this.headingDeg = wrap360(this.headingDeg + this.rateDegS * h);
      remaining -= h;
    }
    return this.headingDeg;
  }

  reset(headingDeg: number): void { this.headingDeg = wrap360(headingDeg); this.rateDegS = 0; }
}
