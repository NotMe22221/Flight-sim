/**
 * MSFS-style piloting assists. They mutate a per-frame copy of the controls in place (never the
 * pilot's persistent `ControlInputs`: the assists *add* to what they are given) and allocate
 * nothing. In the simulator they run after `GfcAutopilot.apply`, on the controls the flight model
 * will fly, so auto-rudder sees the aileron the autopilot is actually applying (README.md).
 *
 *  - auto-rudder: turn coordination from sideslip β in the air (PI on β + aileron feed-forward
 *    for adverse yaw); on the ground with assisted take-off, a runway-heading hold (nosewheel /
 *    rudder) on the heading captured at brake release, blended out after lift-off;
 *  - anti-stall: scales the nose-up pitch input down as α (with α̇ lead) approaches the stall α,
 *    and pushes gently if α still goes past the protected value; optionally (light tail-draggers,
 *    `assistsConfigFor`) also as the airspeed (with its trend) falls towards a speed floor, so a
 *    zoom climb cannot run the aircraft out of airspeed at a nose-high attitude;
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
  /** throttle at or above which the take-off starts (the hold engages; below it the pilot taxis freely) */
  takeoffThrottle: number;
  /** the heading captured at brake release is used if the aircraft has moved less than this since, m */
  releaseMaxTravelM: number;
  /** throttle below which the hold lets go once slower than `releaseSpeedMs` (rejected take-off, exit) */
  idleThrottle: number;
  releaseSpeedMs: number;
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
  /**
   * Speed floor, m/s (0 = off): nose-up authority also fades as IAS + `speedLeadS`·dIAS/dt falls from
   * `speedStartMs` to `speedFloorMs`, and below the floor a push of `speedPushPerMs` per m/s of deficit
   * (up to `maxPush`) is added.
   */
  speedFloorMs: number;
  speedStartMs: number;
  speedLeadS: number;
  speedPushPerMs: number;
}

export interface AssistsConfig {
  autoRudder: AutoRudderConfig;
  takeoff: TakeoffAssistConfig;
  antiStall: AntiStallConfig;
}

export const defaultAssistsConfig = (): AssistsConfig => ({
  autoRudder: { betaKp: 3, betaKi: 2, iLim: 0.3, aileronFf: 0.3, authority: 0.6, minIasMs: 35 * KT, pilotYawFreeze: 0.05 },
  takeoff: {
    // re-tuned on the real C172 model after its rudder got 50 % slipstream immersion (src/fdm c172.ts)
    headingKp: 8.0, yawRateKd: 3.0, headingKi: 3.0, iLim: 0.3, authority: 0.8,
    refSpeedMs: 15, scaleMin: 0.3, scaleMax: 3, brakeOn: 0.5,
    takeoffThrottle: 0.6, releaseMaxTravelM: 30, idleThrottle: 0.2, releaseSpeedMs: 15 * KT, liftoffBlendS: 3,
  },
  antiStall: {
    stallAlphaRad: 0.28, startMarginRad: 5 * DEG, endMarginRad: 1.5 * DEG, leadS: 0.3,
    pushGain: 4, maxPush: 0.3, minIasMs: 25 * KT,
    speedFloorMs: 0, speedStartMs: 0, speedLeadS: 1.5, speedPushPerMs: 0.05,
  },
});

/**
 * True for a tail-dragger: a steerable or castering wheel behind the CG (body x < 0) carries the
 * tail (the Super Cub; the 172's nose wheel is ahead of the CG).
 */
export const isTailDragger = (config: AircraftConfig): boolean =>
  config.gear.some((g) => g.type === 'wheel' && g.pos[0] < 0 && (g.maxSteerDeg > 0 || g.casters));

/**
 * Assists tuning for an aircraft: the stall α from its CL table; for a light tail-dragger (Super
 * Cub) also the anti-stall speed floor at Vs1 (fading in from 1.3 Vs1, 3 s speed-trend lead) and
 * protection down to 12 kt. Its strong elevator would otherwise zoom it to 50° nose-up with α held
 * below the stall until the airspeed was gone (an α limiter cannot stop that). The take-off heading
 * hold's C172 gains already hold the Cub's runway heading within 3° through tail-up and lift-off
 * (cubAssists.test.ts), so they are kept.
 */
export function assistsConfigFor(config: AircraftConfig): DeepPartial<AssistsConfig> {
  const stallAlphaRad = stallAlphaFromConfig(config);
  if (!isTailDragger(config)) return { antiStall: { stallAlphaRad } };
  const vs1 = config.limits.Vs1Kt * KT;
  return { antiStall: { stallAlphaRad, minIasMs: 12 * KT, speedFloorMs: vs1, speedStartMs: 1.3 * vs1, speedLeadS: 3, speedPushPerMs: 0.05 } };
}

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
  /** filtered dIAS/dt seen by the anti-stall speed floor, m/s² */
  iasRate = 0;

  private betaI = 0;
  private hdgI = 0;
  private holding = false;
  private holdHeading = Number.NaN;
  private brakesWereSet = false;
  private releaseHeading = Number.NaN;
  private releaseN = 0;
  private releaseE = 0;
  private airborneT = 0;
  private iasPrev = Number.NaN;

  constructor(config?: DeepPartial<AssistsConfig>) {
    this.config = mergeConfig(defaultAssistsConfig(), config);
  }

  /** Runway heading (true, rad) held on the ground, or NaN when no hold is active. */
  get takeoffHeadingRad(): number { return this.holding ? this.holdHeading : Number.NaN; }
  /** Heading (true, rad) captured at the last brake release, NaN when none is pending. */
  get releaseHeadingRad(): number { return this.releaseHeading; }

  /** Clear all assist state (new flight / respawn). */
  reset(): void {
    this.betaI = 0; this.hdgI = 0; this.holding = false; this.holdHeading = Number.NaN;
    this.brakesWereSet = false; this.releaseHeading = Number.NaN; this.airborneT = 0;
    this.antiStallFactor = 1; this.antiStallPush = 0; this.rudderAssist = 0;
    this.iasPrev = Number.NaN; this.iasRate = 0;
  }

  /** Run the enabled assists in the right order (rudder, then pitch limiter). */
  apply(inputs: ControlInputs, s: AircraftState, dt: number, flags: AssistFlags): void {
    this.assistedTakeoff = flags.assistedTakeoff;
    this.coordinateInAir = flags.autoRudder;
    if (flags.autoRudder || flags.assistedTakeoff) this.autoRudder(inputs, s, dt);
    else { this.rudderAssist = 0; this.betaI = 0; this.dropHold(); this.disarm(); }
    if (flags.antiStall) this.antiStall(inputs, s, dt);
    else { this.antiStallFactor = 1; this.antiStallPush = 0; }
  }

  /**
   * Auto-rudder. In the air: rudder = Kp·β + ∫Ki·β + Kff·aileron (faded in above `minIasMs`).
   * On the ground with `assistedTakeoff`: the heading is captured when the brakes come off; the
   * hold engages when take-off power is set (throttle ≥ `takeoffThrottle` while slow) and steers
   * that heading — or the current one if the aircraft has taxied more than `releaseMaxTravelM`
   * since the release (rolling take-off) — with a speed-scheduled PID on heading error and yaw
   * rate. Taxiing below take-off power is never steered. The hold fades into the airborne
   * coordination over `liftoffBlendS` after lift-off, and lets go when the brakes are set or the
   * throttle is closed below `releaseSpeedMs`. The pilot's own pedal input is kept and the assist
   * is added to it. Mutates `inputs.yaw`.
   */
  autoRudder(inputs: ControlInputs, s: AircraftState, dt: number): void {
    if (!(dt > 0)) return;
    const pilotYaw = inputs.yaw;
    let assist = 0;
    if (s.onGround) {
      this.airborneT = 0;
      this.betaI = 0;
      if (this.assistedTakeoff) assist = this.groundHold(inputs, s, dt);
      else { this.dropHold(); this.disarm(); }
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
    if (!Number.isFinite(assist)) assist = 0; // garbage air data: never hand NaN to the flight model
    this.rudderAssist = assist;
    inputs.yaw = clamp(pilotYaw + assist, -1, 1);
  }

  /**
   * Anti-stall: nose-up pitch input × (1 − smoothstep(α_start, α_protect, α + τ·α̇)); beyond the
   * protected α a nose-down push proportional to the excess is added. Nose-down inputs are never
   * reduced. Inactive on the ground and below `minIasMs`. Mutates `inputs.pitch`.
   */
  antiStall(inputs: ControlInputs, s: AircraftState, dt: number): void {
    const c = this.config.antiStall;
    if (c.speedFloorMs > 0) this.trackIas(s.aero.ias, dt);
    if (s.onGround || s.aero.ias < c.minIasMs) { this.antiStallFactor = 1; this.antiStallPush = 0; return; }
    const alphaEff = s.aero.alpha + c.leadS * s.aero.alphaDot;
    if (!Number.isFinite(alphaEff)) { this.antiStallFactor = 1; this.antiStallPush = 0; return; } // no α: leave the stick alone
    const start = c.stallAlphaRad - c.startMarginRad;
    const protect = c.stallAlphaRad - c.endMarginRad;
    let factor = 1 - smoothstep(start, protect, alphaEff);
    let push = alphaEff > protect ? -Math.min(c.maxPush, c.pushGain * (alphaEff - protect)) : 0;
    if (c.speedFloorMs > 0) {
      // the speed floor: what the airspeed will be in `speedLeadS` at the present deceleration
      const vEff = s.aero.ias + c.speedLeadS * Math.min(0, this.iasRate);
      if (Number.isFinite(vEff)) {
        factor *= smoothstep(c.speedFloorMs, Math.max(c.speedStartMs, c.speedFloorMs + 0.1), vEff);
        if (vEff < c.speedFloorMs) push = Math.min(push, -Math.min(c.maxPush, c.speedPushPerMs * (c.speedFloorMs - vEff)));
      }
    }
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

  /** dIAS/dt through a 0.5 s first-order filter (the speed floor's trend). */
  private trackIas(ias: number, dt: number): void {
    if (!(dt > 0) || !Number.isFinite(ias)) return;
    if (Number.isFinite(this.iasPrev)) {
      const raw = (ias - this.iasPrev) / dt;
      if (Number.isFinite(raw)) this.iasRate += (raw - this.iasRate) * Math.min(1, dt / 0.5);
    }
    this.iasPrev = ias;
  }

  private coordination(inputs: ControlInputs, s: AircraftState, dt: number): number {
    const c = this.config.autoRudder;
    const fade = smoothstep(c.minIasMs, c.minIasMs + 10 * KT, s.aero.ias);
    if (fade === 0) { this.betaI = 0; return 0; }
    const beta = s.aero.beta;
    if (Math.abs(inputs.yaw) <= c.pilotYawFreeze) {
      const bi = clamp(this.betaI + c.betaKi * beta * dt, -c.iLim, c.iLim);
      if (Number.isFinite(bi)) this.betaI = bi; // clamp() passes NaN: it would latch the integral
    }
    return fade * clamp(c.betaKp * beta + this.betaI + c.aileronFf * inputs.roll, -c.authority, c.authority);
  }

  private groundHold(inputs: ControlInputs, s: AircraftState, dt: number): number {
    const c = this.config.takeoff;
    const brakes = inputs.parkingBrake || Math.max(inputs.brakeLeft, inputs.brakeRight) > c.brakeOn;
    if (brakes) {
      // brakes set: no hold; the heading is captured when they come off
      this.brakesWereSet = true;
      return this.dropHold();
    }
    if (this.brakesWereSet) {
      this.brakesWereSet = false;
      this.releaseHeading = s.headingTrueRad;
      this.releaseN = s.posNED[0];
      this.releaseE = s.posNED[1];
    }
    if (!this.holding) {
      // the take-off starts with take-off power while still slow; below it the pilot taxis freely
      if (inputs.throttle < c.takeoffThrottle || s.groundSpeedMs > c.refSpeedMs) return 0;
      const moved = Math.hypot(s.posNED[0] - this.releaseN, s.posNED[1] - this.releaseE);
      const fresh = Number.isFinite(this.releaseHeading) && moved < c.releaseMaxTravelM;
      this.holdHeading = fresh ? this.releaseHeading : s.headingTrueRad;
      this.releaseHeading = Number.NaN;
      this.holding = true;
      this.hdgI = 0;
    } else if (inputs.throttle < c.idleThrottle && s.groundSpeedMs < c.releaseSpeedMs) return this.dropHold(); // rejected take-off / runway exit
    return this.headingTerm(s, dt);
  }

  private headingTerm(s: AircraftState, dt: number): number {
    const c = this.config.takeoff;
    const err = wrapPi(this.holdHeading - s.headingTrueRad);
    const scale = clamp(c.refSpeedMs / Math.max(s.groundSpeedMs, 0.1), c.scaleMin, c.scaleMax);
    const hi = clamp(this.hdgI + c.headingKi * err * dt, -c.iLim, c.iLim);
    if (Number.isFinite(hi)) this.hdgI = hi;
    return clamp(scale * (c.headingKp * err - c.yawRateKd * s.rates[2]) + this.hdgI, -c.authority, c.authority);
  }

  private dropHold(): number {
    this.holding = false;
    this.holdHeading = Number.NaN;
    this.hdgI = 0;
    return 0;
  }

  private disarm(): void {
    this.brakesWereSet = false;
    this.releaseHeading = Number.NaN;
  }
}
