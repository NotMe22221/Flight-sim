/**
 * Tuning table for the GFC-700-style autopilot. All angles rad, speeds m/s, distances m.
 * The README lists the same numbers in aviation units with the reasoning behind them.
 *
 * Gains of the inner loops are "per normalised surface" (−1..1 stick); the outer loops
 * command attitudes. See docs/research/05-cockpit-avionics-navigation.md §5.2.
 */
import { DEG, FPM, KT, NM, G0 } from '../core/units';
import type { PidConfig } from './pid';

export interface AutopilotLimits {
  /** bank command limit in HDG/NAV/GPS (GFC 700: 22° or 25° selectable) */
  bankRad: number;
  /** bank command limit while tracking a localizer (LOC/APR) */
  bankAprRad: number;
  /** turn-rate cap: the bank is also limited to atan(ω·V/g) for this ω (standard rate 3°/s) */
  turnRateRadS: number;
  /** slew rate of the roll command fed to the roll loop (and the FD bar) */
  rollCmdRateRadS: number;
  /** pitch command limits (GFC 700: +20° / −15°) */
  pitchMaxRad: number;
  pitchMinRad: number;
  /** slew rate of the pitch command */
  pitchCmdRateRadS: number;
  /** vertical-speed command limit used by ALT (and the ALTS capture) */
  altVsLimitMs: number;
  /** selectable vertical speed range in VS mode */
  vsSelectMaxMs: number;
  /** VS command limits while on the glideslope: [descent, climb] */
  gsVsMinMs: number;
  gsVsMaxMs: number;
  /** servo authority as a fraction of full control travel (pilot can always out-muscle it) */
  servoAuthority: number;
  /** servo slew rate, full travel per second */
  servoRatePerS: number;
  /** |roll| below this on ROL engage → wings level instead of holding the roll */
  rolWingsLevelRad: number;
}

export interface AutopilotGains {
  /** roll → aileron inner loop, per rad / rad·s⁻¹ */
  roll: PidConfig;
  /** pitch → elevator inner loop, per rad / rad·s⁻¹ */
  pitch: PidConfig;
  /** feed-forward from the roll-command slew rate to aileron (per rad/s); ≈ 1 / full-aileron roll rate */
  rollFeedForward: number;
  /** feed-forward from the pitch-command slew rate to elevator (per rad/s) */
  pitchFeedForward: number;
  /** HDG: bank command per rad of heading (track) error */
  hdgToBank: number;
  /** ALT: vertical-speed command per metre of altitude error (1/s). 8 fpm/ft = 0.133/s */
  altToVs: number;
  /** ALTS capture: deceleration budget used to compute the capture distance, m/s² */
  altCaptureAccelMs2: number;
  /** ALTS capture: minimum capture distance, m */
  altCaptureMinM: number;
  /** ALTS → ALT when within this distance of the target, m */
  altHoldThresholdM: number;
  /** VS → pitch PI (rad per m/s, rad per m/s per s) */
  vsToPitchKp: number;
  vsToPitchKi: number;
  /** FLC speed → pitch PID (rad per m/s of speed error, rad per m/s per s, rad per m/s²; positive = nose up when fast) */
  flcKp: number;
  flcKi: number;
  flcKd: number;
  /** FLC acceleration filter time constant, s */
  flcTauD: number;
  /** GPS/NAV intercept: rad of intercept angle per metre of cross-track; cap */
  gpsInterceptRadPerM: number;
  gpsInterceptMaxRad: number;
  /** VOR intercept angle at full-scale CDI deflection (1.0); cap */
  vorInterceptRad: number;
  vorInterceptMaxRad: number;
  /** distance below which the VOR gain is scaled down linearly (cone of confusion) */
  vorScaleDistanceM: number;
  vorScaleMin: number;
  /** LOC: intercept angle per dot at the reference distance; scaled ∝ distance / ref, clamped */
  locInterceptRadPerDot: number;
  locRefDistanceM: number;
  locScaleMin: number;
  locScaleMax: number;
  locInterceptMaxRad: number;
  /** LOC integral: rad/s of course offset per dot of standing deviation; its cap */
  locKi: number;
  locIntegralMaxRad: number;
  /** GS: VS correction per dot at the reference distance; scaled ∝ distance / ref, clamped */
  gsVsPerDotMs: number;
  gsRefDistanceM: number;
  gsScaleMin: number;
  gsScaleMax: number;
  /** GS integral: m/s² of VS bias per dot; its cap m/s */
  gsKi: number;
  gsIntegralMaxMs: number;
  /** nominal glide-path angle for the feed-forward descent rate */
  gsNominalAngleRad: number;
  /** distance to the station assumed by the LOC/GS gain schedules when no DME is available */
  fallbackDistanceM: number;
  /** lateral capture: |deviation| in dots at which an armed NAV/LOC captures ... */
  lateralCaptureDots: number;
  /** ... or when the deviation will reach zero within this many seconds at the current closure rate */
  captureLeadS: number;
  /** GPS: metres per dot used for arming/capture (G1000 en-route CDI: 1 nm/dot) */
  gpsMetresPerDot: number;
  /** GS capture: |deviation| dots */
  gsCaptureDots: number;
  /** seconds a nav source may be invalid before the mode reverts to ROL / PIT */
  sourceLossGraceS: number;
  /** gain scheduling of the inner loops with airspeed: kp, kd × (Vref/IAS)^exponent, clamped */
  qbarScheduling: boolean;
  qbarRefSpeedMs: number;
  /** 1: control power ∝ V (rate response, C172 ailerons/elevator); 2: ∝ dynamic pressure */
  qbarScheduleExponent: number;
  qbarScaleMin: number;
  qbarScaleMax: number;
  /** yaw damper: rudder per rad/s of washed-out yaw rate; washout time constant; authority */
  ydGain: number;
  ydWashoutS: number;
  ydAuthority: number;
  /** auto-trim: trim wheel rate (normalised per s), servo deadband, delay before trimming */
  trimRatePerS: number;
  trimDeadband: number;
  trimDelayS: number;
}

export interface AutopilotProtections {
  /** |pilot pitch| or |pilot roll| above this ... */
  overrideThreshold: number;
  /** ... for this long disconnects the AP (CWS-like override) */
  overrideTimeS: number;
  /** |roll| beyond this disconnects */
  maxBankRad: number;
  /** disconnect on the FDM's stall warning */
  disconnectOnStallWarning: boolean;
  /** disconnect on the FDM's overspeed warning */
  disconnectOnOverspeed: boolean;
}

export interface AutopilotBehaviour {
  /**
   * When NAV/APR is selected from ROL (no heading being flown) with the needle outside the
   * capture window, capture immediately and fly the intercept law (MSFS-like). When false, or
   * when HDG is active, the mode stays armed until the needle comes alive (GFC 700 behaviour).
   */
  autoInterceptFromRol: boolean;
  /** `apply()` writes the auto-trim position back into the pilot's `inputs.pitchTrim` so the trim wheel stays where the servo left it on disconnect */
  writeTrimToInputs: boolean;
}

export interface AutopilotConfig {
  limits: AutopilotLimits;
  gains: AutopilotGains;
  protections: AutopilotProtections;
  behaviour: AutopilotBehaviour;
}

export const defaultAutopilotConfig = (): AutopilotConfig => ({
  limits: {
    bankRad: 25 * DEG,
    bankAprRad: 22 * DEG,
    turnRateRadS: 3 * DEG,
    rollCmdRateRadS: 6 * DEG,
    pitchMaxRad: 20 * DEG,
    pitchMinRad: -15 * DEG,
    pitchCmdRateRadS: 2 * DEG,
    altVsLimitMs: 800 * FPM,
    vsSelectMaxMs: 1500 * FPM,
    gsVsMinMs: -1500 * FPM,
    gsVsMaxMs: 200 * FPM,
    servoAuthority: 0.5,
    servoRatePerS: 1.0,
    rolWingsLevelRad: 6 * DEG,
  },
  gains: {
    // Spec §5.2: Kp 0.025 /deg, Ki 0.004 /deg/s, Kd 0.010 per deg/s, out ±0.5, iLim 0.15
    roll: { kp: 0.025 / DEG, ki: 0.004 / DEG, kd: 0.010 / DEG, outMin: -0.5, outMax: 0.5, iLim: 0.15, tt: 1.0 },
    // Spec §5.2: Kp 0.045 /deg, Ki 0.010 /deg/s, Kd 0.020 per deg/s, out ±0.5, iLim 0.20
    pitch: { kp: 0.045 / DEG, ki: 0.010 / DEG, kd: 0.020 / DEG, outMin: -0.5, outMax: 0.5, iLim: 0.2, tt: 1.0 },
    rollFeedForward: 0.6, // 1 / (95°/s)
    pitchFeedForward: 1.5, // 1 / (38°/s)... the pitch servo also carries the α-stiffness load, see README
    hdgToBank: 1.0,
    altToVs: 8 * FPM / 0.3048, // 8 fpm per ft = 0.1333 /s
    altCaptureAccelMs2: 0.03 * G0, // 1000 fpm captures ~185 ft out
    altCaptureMinM: 50 * 0.3048,
    altHoldThresholdM: 15,
    vsToPitchKp: 0.008 * DEG / FPM, // 0.008 deg per fpm → 500 fpm error = 4°
    vsToPitchKi: 0.0012 * DEG / FPM,
    flcKp: 0.6 * DEG / KT, // 0.6 deg per kt
    flcKi: 0.06 * DEG / KT,
    flcKd: 0.5 * DEG / KT, // 0.5 deg per kt/s of acceleration
    flcTauD: 0.5,
    gpsInterceptRadPerM: 60 * DEG / NM, // 60° per nm en route
    gpsInterceptMaxRad: 45 * DEG,
    vorInterceptRad: 45 * DEG, // full-scale needle → 45°
    vorInterceptMaxRad: 45 * DEG,
    vorScaleDistanceM: 10 * NM,
    vorScaleMin: 0.3,
    locInterceptRadPerDot: 15 * DEG,
    locRefDistanceM: 6 * NM,
    locScaleMin: 0.3,
    locScaleMax: 1.5,
    locInterceptMaxRad: 30 * DEG,
    locKi: 0.05 * DEG,
    locIntegralMaxRad: 5 * DEG,
    gsVsPerDotMs: 350 * FPM,
    gsRefDistanceM: 3 * NM,
    gsScaleMin: 0.4,
    gsScaleMax: 1.3,
    gsKi: 8 * FPM, // 8 fpm/s per dot
    gsIntegralMaxMs: 200 * FPM,
    gsNominalAngleRad: 3 * DEG,
    fallbackDistanceM: 3 * NM,
    lateralCaptureDots: 1.0,
    captureLeadS: 8,
    gpsMetresPerDot: 1 * NM,
    gsCaptureDots: 0.5,
    sourceLossGraceS: 2,
    qbarScheduling: true,
    qbarRefSpeedMs: 100 * KT,
    qbarScheduleExponent: 1,
    qbarScaleMin: 0.5,
    qbarScaleMax: 2.0,
    ydGain: 0.8, // rudder per rad/s of washed-out yaw rate
    ydWashoutS: 2.0,
    ydAuthority: 0.3,
    trimRatePerS: 0.04,
    trimDeadband: 0.03,
    trimDelayS: 1.0,
  },
  protections: {
    overrideThreshold: 0.5,
    overrideTimeS: 0.5,
    maxBankRad: 60 * DEG,
    disconnectOnStallWarning: true,
    disconnectOnOverspeed: true,
  },
  behaviour: {
    autoInterceptFromRol: true,
    writeTrimToInputs: true,
  },
});

/** Recursive partial for configuration overrides. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep-merge `patch` onto a copy of `base` (objects only; arrays and primitives are replaced). */
export const mergeConfig = <T extends object>(base: T, patch: DeepPartial<T> | undefined): T => {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (!patch) return out as T;
  for (const key of Object.keys(patch)) {
    const pv = (patch as Record<string, unknown>)[key];
    const bv = out[key];
    if (pv === undefined) continue;
    out[key] = isPlainObject(pv) && isPlainObject(bv) ? mergeConfig(bv, pv) : pv;
  }
  return out as T;
};
