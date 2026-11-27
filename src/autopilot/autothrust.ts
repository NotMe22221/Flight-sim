/**
 * Autothrust (A/THR) for the airliner: drives the throttle lever.
 *
 *   SPEED     holds the autopilot's speed target (`iasTargetMs`) with a PI loop on IAS and an
 *             acceleration term, rate-limited like real thrust levers.
 *   THR CLB / THR IDLE   with the autopilot in FLC the pitch holds the speed, so thrust goes to
 *             climb (target above) or idle (target below).
 *   A.FLOOR   α above α-floor: take-off thrust, whatever the mode.
 *   RETARD    below 20 ft in a descent with the gear down: idle for the flare; disconnects on the ground.
 */
import type { AircraftState, AutopilotState } from '../core/types';
import { clamp } from '../core/math';
import { FT, KT } from '../core/units';

export type AutoThrustMode = 'OFF' | 'SPEED' | 'THR CLB' | 'THR IDLE' | 'A.FLOOR' | 'RETARD';

/** Climb thrust lever position (the CLB detent; 1 = take-off/go-around). */
export const CLB_THRUST = 0.9;

export class AutoThrust {
  engaged = false;
  mode: AutoThrustMode = 'OFF';
  /** lever position commanded, 0..1 */
  throttle = 0;
  private integ = 0;
  private lastIas = NaN;
  private accel = 0;

  engage(on: boolean, currentThrottle: number): void {
    this.engaged = on;
    this.mode = on ? 'SPEED' : 'OFF';
    this.throttle = clamp(currentThrottle, 0, 1);
    this.integ = this.throttle;
    this.lastIas = NaN; this.accel = 0;
  }

  toggle(currentThrottle: number): void { this.engage(!this.engaged, currentThrottle); }

  /** One step: returns the lever position to fly, or null when disengaged. */
  update(dt: number, s: AircraftState, ap: AutopilotState, alphaFloor: boolean, gearDown: boolean): number | null {
    if (!(dt > 0)) return this.engaged ? this.throttle : null;
    const ias = s.aero.ias;
    if (Number.isFinite(this.lastIas)) this.accel += ((ias - this.lastIas) / dt - this.accel) * (1 - Math.exp(-dt / 1.5));
    this.lastIas = ias;
    if (alphaFloor && !s.onGround) { this.engaged = true; this.mode = 'A.FLOOR'; return this.slew(1, dt); }
    if (!this.engaged) return null;
    if (s.onGround && this.mode === 'RETARD') { this.engage(false, 0); return null; }
    if (!s.onGround && gearDown && s.altitudeAglM < 20 * FT && s.verticalSpeedMs < 0) { this.mode = 'RETARD'; return this.slew(0, dt, 0.5); }
    if (ap.engaged && ap.vertical === 'FLC') {
      const climb = ap.altitudeTargetM > s.altitudeMslM + 30;
      this.mode = climb ? 'THR CLB' : 'THR IDLE';
      this.integ = climb ? CLB_THRUST : 0;
      return this.slew(climb ? CLB_THRUST : 0, dt);
    }
    this.mode = 'SPEED';
    const err = (ap.iasTargetMs - ias) / KT;
    this.integ = clamp(this.integ + 0.004 * err * dt, 0, 1);
    const cmd = clamp(this.integ + 0.025 * err - 0.12 * (this.accel / KT), 0, CLB_THRUST + 0.05);
    return this.slew(cmd, dt);
  }

  /** Lever motion limited to `rate` per second (≈ 10 %/s, like the real levers' servo). */
  private slew(target: number, dt: number, rate = 0.1): number {
    const d = clamp(target - this.throttle, -rate * dt, rate * dt);
    this.throttle = clamp(this.throttle + d, 0, 1);
    return this.throttle;
  }
}
