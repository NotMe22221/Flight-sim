/**
 * Lateral outer-loop control laws (pure functions). They turn a mode's target into a bank
 * command; the roll inner loop turns that into an aileron command. Angles rad.
 */
import { clamp, wrapPi } from '../core/math';
import { G0 } from '../core/units';
import type { AutopilotGains } from './config';

/** Bank that gives turn rate ω at true airspeed V: atan(ω·V/g). */
export const bankForTurnRate = (turnRateRadS: number, tasMs: number): number =>
  Math.atan((turnRateRadS * Math.max(tasMs, 10)) / G0);

/** Effective bank limit: the configured limit or the standard-rate bank, whichever is lower. */
export const effectiveBankLimit = (bankLimitRad: number, turnRateRadS: number, tasMs: number): number =>
  Math.min(bankLimitRad, bankForTurnRate(turnRateRadS, tasMs));

/** HDG law: bank = k · (shortest heading error), limited. */
export const headingToBank = (targetRad: number, currentRad: number, k: number, limitRad: number): number =>
  clamp(k * wrapPi(targetRad - currentRad), -limitRad, limitRad);

/**
 * GPS/FMS course intercept: desired track plus an intercept angle proportional to the
 * cross-track error (positive = right of course → intercept to the left), capped.
 */
export const gpsInterceptTrack = (desiredTrackRad: number, crossTrackM: number, g: AutopilotGains): number =>
  desiredTrackRad - clamp(g.gpsInterceptRadPerM * crossTrackM, -g.gpsInterceptMaxRad, g.gpsInterceptMaxRad);

/**
 * VOR course intercept from the CDI needle (−1..1 full scale, + = fly right). The gain is
 * scaled down close to the station (needle sensitivity grows as 1/distance).
 * @param distanceM DME distance or ≤ 0 when unknown
 */
export const vorInterceptTrack = (courseRad: number, cdi: number, distanceM: number, g: AutopilotGains): number => {
  const scale = distanceM > 0 ? clamp(distanceM / g.vorScaleDistanceM, g.vorScaleMin, 1) : 1;
  return courseRad + clamp(g.vorInterceptRad * scale * cdi, -g.vorInterceptMaxRad, g.vorInterceptMaxRad);
};

/** Localizer intercept gain (rad per dot) scheduled with distance to the antenna. */
export const locGain = (distanceM: number, g: AutopilotGains): number =>
  g.locInterceptRadPerDot * clamp(distanceM / g.locRefDistanceM, g.locScaleMin, g.locScaleMax);

/**
 * Localizer tracking: course + K(d)·dots + integral, capped. Dots are CDI × 2 (two-dot scale),
 * + = fly right. The integral (rad) removes standing offsets in crosswind.
 */
export const locInterceptTrack = (courseRad: number, dots: number, distanceM: number, integralRad: number, g: AutopilotGains): number =>
  courseRad + clamp(locGain(distanceM, g) * dots + integralRad, -g.locInterceptMaxRad, g.locInterceptMaxRad);

/** Convert a CDI value (−1..1 full scale) to dots on a two-dot scale. */
export const cdiToDots = (cdi: number): number => cdi * 2;
