/**
 * MSFS-style piloting assists. They act on the pilot's `ControlInputs` *before* the autopilot
 * (`GfcAutopilot.apply`) and mutate them in place; nothing allocates per frame.
 *
 *  - auto-rudder: turn coordination from sideslip β in the air (PI on β + aileron feed-forward
 *    for adverse yaw); on the ground with assisted take-off, a runway-heading hold (nosewheel /
 *    rudder) on the heading captured at brake release, blended out after lift-off;
 *  - anti-stall: scales the nose-up pitch input down as α (with α̇ lead) approaches the stall α,
 *    and pushes gently if α still goes past the protected value;
 *  - LVL emergency: wings level + zero vertical speed from any attitude, flown by the autopilot's
 *    own roll / pitch / VS loops (`GfcAutopilot.level()`).
 *
 * Sign conventions (ControlInputs): yaw + = nose right, pitch + = nose up, roll + = right.
 * Sideslip β > 0 = relative wind from the right (nose left of the flight path) → right rudder.
 */
import type { AircraftConfig, AircraftState, AssistanceOptions, ControlInputs } from '../core/types';
import { clamp, smoothstep, wrapPi } from '../core/math';
import { DEG, KT } from '../core/units';
import { type DeepPartial, mergeConfig } from './config';
import type { GfcAutopilot } from './Autopilot';

export interface AutoRudderConfig {
  /** rudder per rad of sideslip (proportional) */
  betaKp: number;
  /** rudder per rad·s of sideslip (integral: trims out P-factor / steady-turn slip) */
  betaKi: number;
  /** integral authority, rudder units */
  iLim: number;
  /** rudder per unit of aileron (adverse-yaw feed-forward) */
  aileronFf: number;
  /** authority of the airborne coordination, rudder units */
  authority: number;
  /** below this IAS the coordination fades out (β is noise when slow), m/s; fully on 10 kt above */
  minIasMs: number;
  /** |pilot yaw| above this freezes the integral (deliberate slips stay possible) */
  pilotYawFreeze: number;
}

export interface TakeoffAssistConfig {
  /** pedal per rad of heading error at `refSpeedMs` */
  headingKp: number;
  /** pedal per rad/s of yaw rate at `refSpeedMs` (damping) */
  yawRateKd: number;
  /** pedal per rad·s of heading error (trims out P-factor and crosswind) */
  headingKi: number;
  /** integral authority, pedal units */
  iLim: number;
  /** authority of the heading hold, pedal units */
  authority: number;
  /** steering power grows with speed, so P/D are scaled by refSpeed / groundSpeed (clamped) */
  refSpeedMs: number;
  scaleMin: number;
  scaleMax: number;
  /** toe-brake level above which the brakes count as applied */
  brakeOn: number;
  /** throttle above which a rolling take-off (no brake release seen) captures the heading */
  rollingThrottle: number;
  /** the hold ends when the aircraft slows below this with the throttle closed (taxi / abort), m/s */
  stopSpeedMs: number;
  /** seconds after lift-off over which the heading hold hands over to the airborne coordination */
  liftoffBlendS: number;
}

export interface AntiStallConfig {
  /** stall angle of attack (CLmax), rad. C172 FDM: 0.28 (use `stallAlphaFromConfig`) */
  stallAlphaRad: number;
  /** nose-up authority starts to drop this far below the stall α */
  startMarginRad: number;
  /** nose-up authority is zero this far below the stall α (the protected α) */
  endMarginRad: number;
  /** α-rate lead: α + leadS·α̇ is compared with the thresholds, s */
  leadS: number;
  /** nose-down push per rad beyond the protected α, stick units */
  pushGain: number;
  /** largest push, stick units */
  maxPush: number;
  /** below this IAS α is not trusted and nothing is done, m/s */
  minIasMs: number;
}

export interface AssistsConfig {
  autoRudder: AutoRudderConfig;
  takeoff: TakeoffAssistConfig;
  antiStall: AntiStallConfig;
}

export const defaultAssistsConfig = (): AssistsConfig => ({
  autoRudder: { betaKp: 3, betaKi: 2, iLim: 0.3, aileronFf: 0.3, authority: 0.6, minIasMs: 35 * KT, pilotYawFreeze: 0.05 },
  takeoff: {
    headingKp: 2.0, yawRateKd: 1.2, headingKi: 0.5, iLim: 0.3, authority: 0.8,
    refSpeedMs: 15, scaleMin: 0.3, scaleMax: 3, brakeOn: 0.5, rollingThrottle: 0.6, stopSpeedMs: 3, liftoffBlendS: 3,
  },
  antiStall: {
    stallAlphaRad: 0.28, startMarginRad: 5 * DEG, endMarginRad: 1.5 * DEG, leadS: 0.3,
    pushGain: 4, maxPush: 0.3, minIasMs: 25 * KT,
  },
});

/**
 * Stall angle of attack of an aircraft: the α of the largest CL in the normal (pre-stall) column
 * of `config.aero.CL.table` (row-major, rows = α).
 */
export const stallAlphaFromConfig = (config: AircraftConfig): number => {
  const t = config.aero.CL.table;
  const nc = t.cols.length;
  let best = -Infinity, alpha = 0.28;
  for (let i = 0; i < t.rows.length; i++) {
    const cl = t.data[i * nc];
    if (cl > best) { best = cl; alpha = t.rows[i]; }
  }
  return alpha;
};

/** Which assists `FlightAssists.apply` runs (a subset of `AssistanceOptions`, plus anti-stall). */
export type AssistFlags = Pick<AssistanceOptions, 'autoRudder' | 'assistedTakeoff'> & { antiStall?: boolean };

export class FlightAssists {
  readonly config: AssistsConfig;
  /** ground runway-heading hold during the take-off roll (mirrors `AssistanceOptions.assistedTakeoff`) */
  assistedTakeoff = false;
  /** airborne turn coordination from β (on by default when `autoRudder` is called directly) */
  coordinateInAir = true;
  /** nose-up authority left by the last `antiStall` call (1 = untouched, 0 = none) */
  antiStallFactor = 1;
  /** nose-down push added by the last `antiStall` call, stick units (≤ 0) */
  antiStallPush = 0;
  /** rudder added by the last `autoRudder` call */
  rudderAssist = 0;

  private betaI = 0;
  private hdgI = 0;
  private holding = false;
  private holdHeading = Number.NaN;
  private brakeArmed = false;
  private airborneT = 0;

  constructor(config?: DeepPartial<AssistsConfig>) {
    this.config = mergeConfig(defaultAssistsConfig(), config);
  }

  /** Runway heading (true, rad) held on the ground, or NaN when no hold is active. */
  get takeoffHeadingRad(): number { return this.holding ? this.holdHeading : Number.NaN; }

  /** Clear all assist state (new flight / respawn). */
  reset(): void {
    this.betaI = 0; this.hdgI = 0; this.holding = false; this.holdHeading = Number.NaN;
    this.brakeArmed = false; this.airborneT = 0;
    this.antiStallFactor = 1; this.antiStallPush = 0; this.rudderAssist = 0;
  }

  /** Run the enabled assists in the right order (rudder, then pitch limiter). */
  apply(inputs: ControlInputs, s: AircraftState, dt: number, flags: AssistFlags): void {
    this.assistedTakeoff = flags.assistedTakeoff;
    this.coordinateInAir = flags.autoRudder;
    if (flags.autoRudder || flags.assistedTakeoff) this.autoRudder(inputs, s, dt);
    else { this.rudderAssist = 0; this.betaI = 0; this.holding = false; }
    if (flags.antiStall) this.antiStall(inputs, s, dt);
    else { this.antiStallFactor = 1; this.antiStallPush = 0; }
  }

  /**
   * Auto-rudder. In the air: rudder = Kp·β + ∫Ki·β + Kff·aileron (faded in above `minIasMs`).
   * On the ground with `assistedTakeoff`: hold the heading captured at brake release (or when a
   * rolling take-off starts) with a speed-scheduled PID on heading error and yaw rate; the hold
   * fades into the airborne coordination over `liftoffBlendS` after lift-off. The pilot's own
   * pedal input is kept and the assist is added to it. Mutates `inputs.yaw`.
   */
  autoRudder(inputs: ControlInputs, s: AircraftState, dt: number): void {
    if (!(dt > 0)) return;
    const pilotYaw = inputs.yaw;
    let assist = 0;
    if (s.onGround) {
      this.airborneT = 0;
      this.betaI = 0;
      assist = this.assistedTakeoff ? this.groundHold(inputs, s, dt) : this.dropHold();
    } else {
      this.airborneT += dt;
      const air = this.coordinateInAir ? this.coordination(inputs, s, dt) : 0;
      if (this.holding) {
        const tb = this.config.takeoff;
        const w = tb.liftoffBlendS > 0 ? clamp(1 - this.airborneT / tb.liftoffBlendS, 0, 1) : 0;
        assist = w * this.headingTerm(s, dt) + (1 - w) * air;
        if (w === 0) this.dropHold();
      } else assist = air;
    }
    this.rudderAssist = assist;
    inputs.yaw = clamp(pilotYaw + assist, -1, 1);
  }

  /**
   * Anti-stall: nose-up pitch input × (1 − smoothstep(α_start, α_protect, α + τ·α̇)); beyond the
   * protected α a nose-down push proportional to the excess is added. Nose-down inputs are never
   * reduced. Inactive on the ground and below `minIasMs`. Mutates `inputs.pitch`.
   */
  antiStall(inputs: ControlInputs, s: AircraftState, dt: number): void {
    void dt;
    const c = this.config.antiStall;
    if (s.onGround || s.aero.ias < c.minIasMs) { this.antiStallFactor = 1; this.antiStallPush = 0; return; }
    const alphaEff = s.aero.alpha + c.leadS * s.aero.alphaDot;
    const start = c.stallAlphaRad - c.startMarginRad;
    const protect = c.stallAlphaRad - c.endMarginRad;
    const factor = 1 - smoothstep(start, protect, alphaEff);
    const push = alphaEff > protect ? -Math.min(c.maxPush, c.pushGain * (alphaEff - protect)) : 0;
    let pitch = inputs.pitch > 0 ? inputs.pitch * factor : inputs.pitch;
    pitch = clamp(pitch + push, -1, 1);
    this.antiStallFactor = factor;
    this.antiStallPush = push;
    inputs.pitch = pitch;
  }

  /**
   * LVL emergency: engage the autopilot in level mode — wings level and zero vertical speed from
   * any attitude, using its own roll / pitch / VS loops (bank, overspeed and stall-warning
   * disconnects suspended, wings first, load-factor-limited pull-up, α ceiling). The pilot ends it
   * by selecting another mode or disconnecting the autopilot.
   */
  emergencyLevel(ap: GfcAutopilot): void {
    ap.level();
  }

  // ───────────────────────────── internals ─────────────────────────────

  private coordination(inputs: ControlInputs, s: AircraftState, dt: number): number {
    const c = this.config.autoRudder;
    const fade = smoothstep(c.minIasMs, c.minIasMs + 10 * KT, s.aero.ias);
    if (fade === 0) { this.betaI = 0; return 0; }
    const beta = s.aero.beta;
    if (Math.abs(inputs.yaw) <= c.pilotYawFreeze) this.betaI = clamp(this.betaI + c.betaKi * beta * dt, -c.iLim, c.iLim);
    return fade * clamp(c.betaKp * beta + this.betaI + c.aileronFf * inputs.roll, -c.authority, c.authority);
  }

  private groundHold(inputs: ControlInputs, s: AircraftState, dt: number): number {
    const c = this.config.takeoff;
    const brakes = inputs.parkingBrake || Math.max(inputs.brakeLeft, inputs.brakeRight) > c.brakeOn;
    if (brakes) {
      // brakes set: (re)arm; the heading is captured when they come off
      this.brakeArmed = true;
      return this.dropHold();
    }
    if (!this.holding) {
      const rolling = inputs.throttle > c.rollingThrottle && s.groundSpeedMs < c.refSpeedMs;
      if (this.brakeArmed || rolling) {
        this.holding = true;
        this.holdHeading = s.headingTrueRad;
        this.hdgI = 0;
        this.brakeArmed = false;
      } else return 0;
    } else if (inputs.throttle < 0.2 && s.groundSpeedMs < c.stopSpeedMs) return this.dropHold(); // stopped / taxiing
    return this.headingTerm(s, dt);
  }

  private headingTerm(s: AircraftState, dt: number): number {
    const c = this.config.takeoff;
    const err = wrapPi(this.holdHeading - s.headingTrueRad);
    const scale = clamp(c.refSpeedMs / Math.max(s.groundSpeedMs, 0.1), c.scaleMin, c.scaleMax);
    this.hdgI = clamp(this.hdgI + c.headingKi * err * dt, -c.iLim, c.iLim);
    return clamp(scale * (c.headingKp * err - c.yawRateKd * s.rates[2]) + this.hdgI, -c.authority, c.authority);
  }

  private dropHold(): number {
    this.holding = false;
    this.holdHeading = Number.NaN;
    this.hdgI = 0;
    return 0;
  }
}
