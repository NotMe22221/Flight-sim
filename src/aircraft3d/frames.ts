/**
 * Frame conversions between the physics body/NED frames and the Three.js render frame.
 *
 * Conventions (docs/DESIGN.md):
 *  - Physics world frame: NED. Body frame: FRD (x forward, y right, z down).
 *  - `qNB` rotates NED vectors into the body frame (scalar-first [w, x, y, z]).
 *  - Render frame: x = East, y = Up, z = South  ⇒  (x3, y3, z3) = (E, −D, −N).
 *  - Aircraft models are authored nose −Z, up +Y, right wing +X, origin at the empty CG.
 *
 * With q_bn = conj(qNB) = (w, qN, qE, qD) the Three.js object quaternion is
 * (x: qE, y: −qD, z: −qN, w). Substituting conj(qNB) = (w, −x, −y, −z):
 * three = (x: −qNB.y, y: qNB.z, z: qNB.x, w: qNB.w).
 */
import * as THREE from 'three';
import type { Quat, Vec3 } from '../core/types';

/**
 * Convert the FDM attitude quaternion `qNB` (NED → body, scalar-first) into the Three.js
 * object quaternion for a model authored nose −Z / up +Y / right wing +X.
 * Writes into `out` and returns it; no allocation.
 */
export function bodyQuatToThree(qNB: Quat, out: THREE.Quaternion): THREE.Quaternion {
  return out.set(-qNB[2], qNB[3], qNB[1], qNB[0]).normalize();
}

/**
 * Inverse of {@link bodyQuatToThree}: Three.js object quaternion → `qNB` (scalar-first).
 * Writes into `out` (a 4-array) and returns it.
 */
export function threeQuatToBody(q: THREE.Quaternion, out: Quat): Quat {
  out[0] = q.w;
  out[1] = q.z;
  out[2] = -q.x;
  out[3] = q.y;
  // normalise
  const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l; out[3] /= l;
  return out;
}

/**
 * Body-frame (FRD) offset → model-local Three.js vector (nose −Z, up +Y, right +X).
 * (x_fwd, y_right, z_down) ⇒ (x3: y_right, y3: −z_down, z3: −x_fwd).
 */
export function bodyVecToThreeLocal(v: Vec3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(v[1], -v[2], -v[0]);
}

/** Model-local Three.js vector → body-frame (FRD) offset. */
export function threeLocalToBodyVec(v: THREE.Vector3, out: Vec3): Vec3 {
  out[0] = -v.z; out[1] = v.x; out[2] = -v.y;
  return out;
}

/** NED position/vector → Three.js render frame (x E, y U, z S). */
export function nedToThreeVec(v: Vec3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(v[1], -v[2], -v[0]);
}

/** Three.js render-frame vector → NED. */
export function threeVecToNed(v: THREE.Vector3, out: Vec3): Vec3 {
  out[0] = -v.z; out[1] = v.x; out[2] = -v.y;
  return out;
}
