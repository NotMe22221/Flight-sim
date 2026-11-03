/** Small shared helpers for the camera modes (all allocation-free at call time). */
import * as THREE from 'three';
import type { ResolvedCameraOptions } from '../types';

export const WORLD_UP = new THREE.Vector3(0, 1, 0);
export const Y_AXIS = WORLD_UP;
export const Z_AXIS = new THREE.Vector3(0, 0, 1);

const euler = new THREE.Euler();

/**
 * Camera orientation from a compass yaw (rad, clockwise from north; 0 looks north = −Z) and a
 * pitch (rad, + up). Intrinsic Y-then-X rotation.
 */
export function quatFromYawPitch(yaw: number, pitch: number, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromEuler(euler.set(pitch, -yaw, 0, 'YXZ'));
}

/** Compass yaw of a direction vector (rad, clockwise from north). */
export const yawOf = (dir: THREE.Vector3): number => Math.atan2(dir.x, -dir.z);

/** Horizontal unit vector for a compass yaw. */
export function dirFromYaw(yaw: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(Math.sin(yaw), 0, -Math.cos(yaw));
}

/** Keep `p` at least `groundClearanceM` above the terrain when a ground query is configured. */
export function clampAboveGround(p: THREE.Vector3, o: ResolvedCameraOptions): void {
  if (!o.groundHeightThree) return;
  const minY = o.groundHeightThree(p.x, p.z) + o.groundClearanceM;
  if (p.y < minY) p.y = minY;
}

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
