/**
 * Autopilot tuning for the airliner (A320-style): the same GFC-style mode logic as the light aircraft
 * (HDG/NAV/APR, ALT/VS/FLC/GS), with airliner limits (25° bank, ±15/−10° pitch, faster vertical speeds)
 * and inner loops referenced to airliner speeds (the elevator and ailerons are scheduled with dynamic
 * pressure around 250 kt).
 */
import { DEG, FPM, KT } from '../core/units';
import type { AutopilotConfig } from './config';
import type { DeepPartial } from './config';

export const AIRLINER_AUTOPILOT: DeepPartial<AutopilotConfig> = {
  limits: {
    bankRad: 25 * DEG,
    bankAprRad: 25 * DEG,
    rollCmdRateRadS: 4 * DEG,
    pitchMaxRad: 15 * DEG,
    pitchMinRad: -10 * DEG,
    pitchCmdRateRadS: 1.5 * DEG,
    altVsLimitMs: 2500 * FPM,
    vsSelectMaxMs: 4000 * FPM,
    gsVsMinMs: -1800 * FPM,
  },
  gains: {
    qbarRefSpeedMs: 250 * KT,
    qbarScheduleExponent: 2,
    qbarScaleMin: 0.3,
    qbarScaleMax: 3,
  },
};
