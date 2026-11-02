/**
 * Floating-origin rebasing. When the aircraft strays far from the LocalFrame origin we create a
 * new frame at its position and re-express every NED quantity in it. The two tangent planes
 * differ by a small rotation (tilt d/R plus meridian convergence), which this module computes
 * exactly from the WGS84 frames.
 */
import { qNormalize } from '../core/math';
import type { Quat, Vec3 } from '../core/types';
import { LocalFrame } from '../geo/wgs84';

export const REBASE_DISTANCE_M = 20_000;

export interface RebaseTransform {
  /** rotation taking vectors expressed in the OLD frame's NED axes to the NEW frame's NED axes */
  rotation: Quat;
  /** position of the NEW origin expressed in the OLD frame (NED, m) */
  translationNED: Vec3;
  newFrame: LocalFrame;
}

/** Quaternion (scalar-first) from a row-major rotation matrix. */
export function quatFromMatrix(m: ArrayLike<number>, out: Quat = [1, 0, 0, 0]): Quat {
  const m00 = m[0], m01 = m[1], m02 = m[2], m10 = m[3], m11 = m[4], m12 = m[5], m20 = m[6], m21 = m[7], m22 = m[8];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    out[0] = 0.25 * s; out[1] = (m21 - m12) / s; out[2] = (m02 - m20) / s; out[3] = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out[0] = (m21 - m12) / s; out[1] = 0.25 * s; out[2] = (m01 + m10) / s; out[3] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out[0] = (m02 - m20) / s; out[1] = (m01 + m10) / s; out[2] = 0.25 * s; out[3] = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out[0] = (m10 - m01) / s; out[1] = (m02 + m20) / s; out[2] = (m12 + m21) / s; out[3] = 0.25 * s;
  }
  return qNormalize(out, out);
}

/** Should we rebase for an aircraft at this NED position in the current frame? */
export const needsRebase = (posNED: Vec3, threshold = REBASE_DISTANCE_M): boolean =>
  posNED[0] * posNED[0] + posNED[1] * posNED[1] > threshold * threshold;

/**
 * Build the transform from `oldFrame` to a new frame centred under the aircraft (alt0 = 0).
 * Apply with `FlightModel.rebase(rotation, translationNED)`; the new position is
 * `R · (pos − translationNED)` and vectors/attitude are rotated by R.
 */
export function makeRebase(oldFrame: LocalFrame, aircraftPosNED: Vec3): RebaseTransform {
  const geo = oldFrame.nedToGeodetic(aircraftPosNED[0], aircraftPosNED[1], aircraftPosNED[2]);
  const newFrame = new LocalFrame(geo.lat, geo.lon, 0);
  const translationNED = oldFrame.ecefToNED(newFrame.origin);
  const rotation = quatFromMatrix(oldFrame.rotationNEDTo(newFrame));
  return { rotation, translationNED, newFrame };
}
