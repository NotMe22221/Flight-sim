/**
 * Pure helpers for LVL (the GFC 700 blue "level" button) used as an unusual-attitude recovery:
 * wings first, then a load-factor-limited return to zero vertical speed that never asks for more
 * angle of attack than a set limit. The autopilot's normal roll / pitch / VS loops do the flying;
 * these functions only shape their commands. Angles rad, speeds m/s.
 */
import { G0 } from '../core/units';

/**
 * Pitch-command slew rate that a pull-up (or push-over) at `loadFactor` g allows:
 * q = (n − 1)·g / V. Never below `minRateRadS`.
 */
export const loadFactorPitchRate = (loadFactor: number, tasMs: number, minRateRadS: number): number =>
  Math.max(minRateRadS, (Math.max(loadFactor, 1) - 1) * G0 / Math.max(tasMs, 20));

/**
 * Highest pitch attitude that keeps the angle of attack at or below `alphaMaxRad` for the current
 * flight path: θ − α + α_max (the flight path does not change instantly, so raising θ raises α).
 */
export const alphaLimitedPitch = (pitchRad: number, alphaRad: number, alphaMaxRad: number): number =>
  pitchRad - alphaRad + alphaMaxRad;

/** Wings-first rule: true while the bank is too steep for the vertical loop to pull. */
export const wingsFirst = (rollRad: number, wingsFirstBankRad: number): boolean =>
  Math.abs(rollRad) > wingsFirstBankRad;
