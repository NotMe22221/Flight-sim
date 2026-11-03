/**
 * Chase camera: behind and above the aircraft along its horizontal velocity (or heading when
 * slow). The camera *offset* from the aircraft is driven by a critically damped spring
 * (τ ≈ 0.35 s), so steady flight gives no lag while turns and accelerations make the
 * aircraft swing in the frame; the look-at point has its own faster spring (τ ≈ 0.15 s),
 * velocity-compensated so it stays centred at constant speed. Camera roll follows 30 % of
 * the aircraft roll. The distance persists: ×distanceStep per zoom action, continuous with
 * the held cameraZoom axis, clamped to the orbit limits.
 */
import * as THREE from 'three';
import type { CameraState } from '../../core/types';
import { SpringVector3, omegaFromTau } from '../smoothing';
import type { CameraFrame, CameraModeHandler, ResolvedCameraOptions } from '../types';
import { WORLD_UP, Z_AXIS, clamp, clampAboveGround } from './util';

export class ChaseMode implements CameraModeHandler {
  private readonly offset: SpringVector3;
  private readonly look: SpringVector3;
  private readonly targetOffset = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly qRoll = new THREE.Quaternion();
  private dist: number;

  constructor(private readonly state: CameraState, private readonly opts: ResolvedCameraOptions) {
    this.offset = new SpringVector3(omegaFromTau(opts.chasePosTauS));
    this.look = new SpringVector3(omegaFromTau(opts.chaseLookTauS));
    this.dist = clamp(opts.chaseDistanceM, opts.orbitMinM, opts.orbitMaxM);
  }

  enter(frame: CameraFrame, camera: THREE.PerspectiveCamera): void {
    // start from wherever the previous mode left the camera for a smooth transition
    this.offset.reset(this.tmp.subVectors(camera.position, frame.pos));
    this.look.reset(frame.pos);
  }

  snap(frame: CameraFrame): void {
    this.computeTarget(frame);
    this.offset.reset(this.targetOffset);
    this.look.reset(frame.pos);
  }

  shiftOrigin(delta: THREE.Vector3): void { this.look.pos.add(delta); }

  /** current chase distance (m) */
  get distance(): number { return this.dist; }

  private computeTarget(frame: CameraFrame): void {
    const el = this.opts.chaseElevationRad;
    this.targetOffset.copy(frame.velDirH).multiplyScalar(-this.dist * Math.cos(el));
    this.targetOffset.y += this.dist * Math.sin(el);
  }

  update(frame: CameraFrame, camera: THREE.PerspectiveCamera): number | undefined {
    const o = this.opts, dt = frame.dt;
    const zoomExp = -frame.zoomAxis * o.distanceRatePerS * dt;
    this.dist = clamp(this.dist * Math.exp(zoomExp) * Math.pow(o.distanceStep, -frame.zoomSteps), o.orbitMinM, o.orbitMaxM);
    // publish the external camera distance (audio attenuation; orbit starts from it)
    this.state.orbitDistanceM = this.dist;
    this.computeTarget(frame);
    this.offset.update(this.targetOffset, dt);
    camera.position.copy(frame.pos).add(this.offset.pos);
    clampAboveGround(camera.position, o);

    // look-at: lead by the spring's ramp lag so a steady aircraft stays centred
    this.lookTarget.copy(frame.vel).multiplyScalar(2 / this.look.omega).add(frame.pos);
    this.look.update(this.lookTarget, dt);
    camera.up.copy(WORLD_UP);
    camera.lookAt(this.look.pos);
    if (o.chaseRollFollow !== 0) {
      // negative about the view axis (+Z, toward the viewer) banks the camera right
      this.qRoll.setFromAxisAngle(Z_AXIS, -o.chaseRollFollow * frame.roll);
      camera.quaternion.multiply(this.qRoll);
    }
    return undefined;
  }
}
