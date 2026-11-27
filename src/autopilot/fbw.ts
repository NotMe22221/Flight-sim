/**
 * Simplified Airbus-style fly-by-wire "normal law" for the airliner (config.controls.flyByWire).
 * It sits between the pilot's stick and the surfaces, like the assists:
 *
 *   pitch   stick → load-factor demand (1 g ± 1.5 g; neutral holds the flight path, compensating the
 *           bank up to 33°), flown by a PI loop on nz with pitch-rate damping. The integrator is the
 *           auto-trim: let go and the aircraft keeps its attitude.
 *   roll    stick → roll-rate demand (15 °/s at full deflection); neutral holds the bank up to 33° and
 *           rolls back to 33° beyond it.
 *   yaw     turn coordination / yaw damper on the rudder (sideslip and yaw rate), pilot rudder on top.
 *   limits  pitch +30° / −15°, bank 67°, high angle of attack (no further nose-up demand past α-prot),
 *           overspeed (nose-up demand above VMO + 6 kt). `alphaFloor` reports α above α-floor, for
 *           the autothrust to add take-off thrust.
 *
 * On the ground (and below 50 ft in a descent: the flare) the law blends to direct control, so the
 * pilot rotates and flares with the stick as in the real aircraft's ground and flare modes.
 */
import type { AircraftState, ControlInputs } from '../core/types';
import { clamp } from '../core/math';
import { DEG, FT, KT } from '../core/units';

export interface FbwLimits {
  /** VMO, kt (overspeed protection above VMO + 6) */
  vmoKt: number;
  /** α where high-α protection starts (rad); α-floor (rad) */
  alphaProtRad: number;
  alphaFloorRad: number;
}

const MAX_BANK = 67 * DEG, HOLD_BANK = 33 * DEG, MAX_PITCH = 30 * DEG, MIN_PITCH = -15 * DEG;
const ROLL_RATE = 15 * DEG;

export class FlyByWire {
  /** nz integrator (the auto-trim), stick units */
  private integ = 0;
  /** bank held with the stick neutral, rad */
  private bankHold = 0;
  private holding = false;
  /** 0 = direct law (ground / flare), 1 = normal law */
  private blend = 0;
  /** α above α-floor (the autothrust applies take-off thrust) */
  alphaFloor = false;
  /** last load-factor demand, g (diagnostics) */
  nzCmd = 1;

  constructor(private readonly lim: FbwLimits) {}

  /** `stick`: the trim stick the aircraft starts with (an air spawn starts in normal law, trimmed). */
  reset(stick = 0, airborne = false): void { this.integ = clamp(stick, -1, 1); this.bankHold = 0; this.holding = false; this.blend = airborne ? 1 : 0; this.alphaFloor = false; }

  /** Turn coordination / yaw damping only (the autopilot flies pitch and roll; the rudder stays coordinated). */
  coordinate(u: ControlInputs, s: AircraftState): void {
    // the autopilot's auto-trim holds the attitude: the law takes over from a neutral stick when it disconnects
    this.integ = 0; this.holding = false;
    if (s.onGround) return;
    u.yaw = clamp(u.yaw + 3.0 * s.aero.beta - 0.8 * s.rates[2], -1, 1);
  }

  /** Turn the pilot's stick (`u`, mutated) into surface commands for this step. */
  apply(u: ControlInputs, s: AircraftState, dt: number): void {
    if (!(dt > 0)) return;
    const phi = s.euler[0], theta = s.euler[1];
    const p = s.rates[0], q = s.rates[1], r = s.rates[2];
    const ias = s.aero.ias;
    const flare = !s.onGround && s.altitudeAglM < 50 * FT && s.verticalSpeedMs < 0;
    const normal = !s.onGround && !flare && ias > 60 * KT;
    this.blend = clamp(this.blend + (normal ? dt / 2 : -dt / 1.5), 0, 1);
    const stickP = clamp(u.pitch, -1, 1), stickR = clamp(u.roll, -1, 1);
    if (this.blend <= 0) {
      // direct law: the stick moves the surfaces; the integrator follows so the switch is smooth
      this.integ = 0; this.bankHold = phi; this.holding = false;
      this.alphaFloor = false;
      return;
    }

    // ── pitch: C*-like load-factor law ──
    const cphi = Math.cos(clamp(phi, -HOLD_BANK, HOLD_BANK));
    let nz = Math.cos(theta) / Math.max(cphi, 0.5) + (stickP >= 0 ? 1.5 : 2.0) * stickP;
    // pitch-attitude protection: the demand fades out approaching the limits
    if (theta > MAX_PITCH - 5 * DEG && nz > 1) nz = 1 + (nz - 1) * clamp((MAX_PITCH - theta) / (5 * DEG), 0, 1) - 0.5 * clamp((theta - MAX_PITCH) / (5 * DEG), 0, 1);
    // nose-down: the pitch rate is anticipated (1.5 s), so the attitude stops at the limit rather than past it
    const thetaLead = theta + 1.5 * q;
    if (thetaLead < MIN_PITCH + 8 * DEG && nz < 1) nz = 1 + (nz - 1) * clamp((thetaLead - MIN_PITCH) / (8 * DEG), 0, 1) + 1.0 * clamp((MIN_PITCH - thetaLead) / (5 * DEG), 0, 1);
    // high-α protection: no more nose-up demand past α-prot; pushes the nose down beyond it
    const a = s.aero.alpha;
    if (a > this.lim.alphaProtRad && nz > 1) nz = 1 - 4 * (a - this.lim.alphaProtRad);
    this.alphaFloor = a > this.lim.alphaFloorRad;
    // overspeed: nose-up demand above VMO + 6 kt
    const over = ias - (this.lim.vmoKt + 6) * KT;
    if (over > 0) nz = Math.max(nz, 1 + 0.03 * over);
    nz = clamp(nz, -1, 2.5);
    this.nzCmd = nz;
    const e = nz - s.loadFactor[2];
    // gains fall with dynamic pressure (the elevator gets stronger): referenced to 250 kt
    const k = clamp(Math.pow((128.6 / Math.max(ias, 50)), 1.6), 0.25, 4);
    this.integ = clamp(this.integ + 0.6 * k * e * dt, -1, 1);
    const pitch = clamp(this.integ + k * (0.2 * e - 2.0 * q), -1, 1);

    // ── roll: rate command, bank hold ──
    let pCmd: number;
    if (Math.abs(stickR) > 0.04) {
      pCmd = stickR * ROLL_RATE;
      this.holding = false;
    } else {
      if (!this.holding) { this.holding = true; this.bankHold = clamp(phi, -HOLD_BANK, HOLD_BANK); }
      pCmd = clamp(0.8 * (this.bankHold - phi), -ROLL_RATE, ROLL_RATE);
    }
    if (Math.abs(phi) > HOLD_BANK && Math.abs(stickR) < 0.04) pCmd = clamp(0.6 * (Math.sign(phi) * HOLD_BANK - phi), -ROLL_RATE / 2, ROLL_RATE / 2);
    if (phi > MAX_BANK && pCmd > 0) pCmd = -0.5 * (phi - MAX_BANK);
    if (phi < -MAX_BANK && pCmd < 0) pCmd = -0.5 * (phi + MAX_BANK);
    const roll = clamp(k * 6.0 * (pCmd - p), -1, 1);

    // ── yaw: coordination and damping on top of the pilot's rudder ──
    const yaw = clamp(u.yaw + 3.0 * s.aero.beta - 0.8 * r, -1, 1);

    const b = this.blend;
    u.pitch = b * pitch + (1 - b) * stickP;
    u.roll = b * roll + (1 - b) * stickR;
    u.yaw = b * yaw + (1 - b) * u.yaw;
  }
}

/** Fly-by-wire limits for an aircraft (null: conventional controls). */
export function fbwFor(c: { controls: { flyByWire?: boolean }; limits: { VneKt: number } }): FlyByWire | null {
  return c.controls.flyByWire ? new FlyByWire({ vmoKt: c.limits.VneKt, alphaProtRad: 0.2, alphaFloorRad: 0.23 }) : null;
}
