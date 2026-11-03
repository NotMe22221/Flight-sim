/**
 * Tower camera: fixed world position looking at the aircraft with an automatic field of view
 * that keeps the aircraft's length at ~4 % of the frame height (clamped 2°..60°).
 */
import * as THREE from 'three';
import { SpringVector3, expSmoothing, omegaFromTau } from '../smoothing';
import type { CameraFrame, CameraModeHandler, ResolvedCameraOptions } from '../types';
import { WORLD_UP, clamp } from './util';

const R2D = 180 / Math.PI;

/**
 * Vertical FOV (deg) that shows an object of `lengthM` at `distanceM` as `frameFraction` of
 * the frame height, clamped. Monotonically non-increasing with distance.
 */
export function autoFovDeg(distanceM: number, lengthM: number, frameFraction: number, minDeg: number, maxDeg: number): number {
  const angular = 2 * Math.atan((0.5 * lengthM) / Math.max(distanceM, 1e-3));
  return clamp((angular / Math.max(frameFraction, 1e-4)) * R2D, minDeg, maxDeg);
}

export class TowerMode implements CameraModeHandler {
  readonly position = new THREE.Vector3();
  private seeded = false;
  private readonly look = new SpringVector3(omegaFromTau(0.3));
  private readonly lookTarget = new THREE.Vector3();
  private fovS = 0;

  constructor(private readonly opts: ResolvedCameraOptions) {}

  /** Put the tower 300 m to the left of the aircraft and 20 m up (used at spawn). */
  seedFromAircraft(frame: CameraFrame): void {
    this.position.copy(frame.pos).addScaledVector(frame.right, -300);
    this.position.y = frame.pos.y + 20;
    this.seeded = true;
  }

  setPosition(p: THREE.Vector3): void {
    this.position.copy(p);
    this.seeded = true;
  }

  get isSeeded(): boolean { return this.seeded; }

  /** Forget the tower position; the controller re-seeds it from the aircraft on the next update. */
  unseed(): void { this.seeded = false; }

  enter(frame: CameraFrame): void {
    if (!this.seeded) this.seedFromAircraft(frame);
    this.look.reset(frame.pos);
    this.fovS = this.fovFor(frame);
  }

  snap(frame: CameraFrame): void { this.enter(frame); }

  shiftOrigin(delta: THREE.Vector3): void {
    this.position.add(delta);
    this.look.pos.add(delta);
  }

  private fovFor(frame: CameraFrame): number {
    const o = this.opts;
    return autoFovDeg(this.position.distanceTo(frame.pos), o.aircraftLengthM, o.towerFrameFraction, o.towerMinFovDeg, o.towerMaxFovDeg);
  }

  update(frame: CameraFrame, camera: THREE.PerspectiveCamera): number | undefined {
    const dt = frame.dt;
    camera.position.copy(this.position);
    this.lookTarget.copy(frame.vel).multiplyScalar(2 / this.look.omega).add(frame.pos);
    this.look.update(this.lookTarget, dt);
    camera.up.copy(WORLD_UP);
    camera.lookAt(this.look.pos);
    this.fovS += (this.fovFor(frame) - this.fovS) * expSmoothing(dt, this.opts.towerFovTauS);
    return this.fovS;
  }
}
