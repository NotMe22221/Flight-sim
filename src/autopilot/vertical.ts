/**
 * Vertical outer-loop control laws (pure functions). They produce a vertical-speed command
 * (ALT, ALTS, GS) or a pitch command (PIT, FLC) that the VS→pitch loop and the pitch inner
 * loop then follow. SI units.
 */
import { clamp } from '../core/math';
import type { AutopilotGains } from './config';

/** ALT law: VS command proportional to the altitude error, limited. */
export const altitudeToVs = (errM: number, k: number, limitMs: number): number => clamp(k * errM, -limitMs, limitMs);

/**
 * ALTS capture distance: the altitude needed to arrest the current vertical speed with the
 * configured deceleration (× 1.3 margin), never less than the minimum. v²/(2a) kinematics.
 */
export const altCaptureDistance = (vsMs: number, g: AutopilotGains): number =>
  Math.max(g.altCaptureMinM, (1.3 * vsMs * vsMs) / (2 * g.altCaptureAccelMs2));

/** Glideslope VS gain (m/s per dot) scheduled with distance to the antenna. */
export const gsGain = (distanceM: number, g: AutopilotGains): number =>
  g.gsVsPerDotMs * clamp(distanceM / g.gsRefDistanceM, g.gsScaleMin, g.gsScaleMax);

/**
 * Glideslope law: feed-forward descent rate for the nominal path angle at the current ground
 * speed, plus a correction proportional to the deviation (dots, + = fly up) and an integral.
 */
export const glideslopeVs = (groundSpeedMs: number, dots: number, distanceM: number, integralMs: number, g: AutopilotGains, vsMin: number, vsMax: number): number => {
  const pathVs = -groundSpeedMs * Math.tan(g.gsNominalAngleRad);
  return clamp(pathVs + gsGain(distanceM, g) * dots + integralMs, vsMin, vsMax);
};

/** Pitch attitude that would give zero vertical speed right now (≈ angle of attack). */
export const levelFlightPitch = (pitchRad: number, vsMs: number, tasMs: number): number =>
  pitchRad - Math.asin(clamp(vsMs / Math.max(tasMs, 1), -1, 1));
