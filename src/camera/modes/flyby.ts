/**
 * Fly-by camera: seeds a fixed point ≈ 400 m ahead of the aircraft's track and 50 m to the
 * side (alternating sides), slightly below the aircraft, tracks the aircraft as it passes
 * and re-seeds once it is well past. A mild auto-zoom tightens as the aircraft nears.
 */
import * as THREE from 'three';
import { SpringVector3, expSmoothing, omegaFromTau } from '../smoothing';
import type { CameraFrame, CameraModeHandler, ResolvedCameraOptions } from '../types';
import { WORLD_UP, clampAboveGround } from './util';
import { autoFovDeg } from './tower';

export class FlybyMode implements CameraModeHandler {
  readonly position = new THREE.Vector3();
  private readonly seedDir = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly look = new SpringVector3(omegaFromTau(0.1));
  private readonly lookTarget = new THREE.Vector3();
  private side = 1;
  private fovS = 50;
  /** number of seeds so far (tests) */
  seeds = 0;

  constructor(private readonly opts: ResolvedCameraOptions) {}

  seed(frame: CameraFrame): void {
    const o = this.opts;
    this.seedDir.copy(frame.velDirH);
    // right of the track (clockwise from above)
    this.tmp.set(-this.seedDir.z, 0, this.seedDir.x);
    this.position.copy(frame.pos).addScaledVector(this.seedDir, o.flybyAheadM).addScaledVector(this.tmp, this.side * o.flybySideM);
    this.position.y = frame.pos.y - Math.min(10, Math.max(0, frame.aircraft.altitudeAglM - 3));
    clampAboveGround(this.position, o);
    this.side = -this.side;
    this.look.reset(frame.pos);
    this.seeds++;
  }

  enter(frame: CameraFrame): void { this.seed(frame); }
  reset(frame: CameraFrame): void { this.seed(frame); }
  snap(frame: CameraFrame): void { this.seed(frame); }

  shiftOrigin(delta: THREE.Vector3): void {
    this.position.add(delta);
    this.look.pos.add(delta);
  }

  update(frame: CameraFrame, camera: THREE.PerspectiveCamera): number | undefined {
    const dt = frame.dt;
    this.tmp.subVectors(frame.pos, this.position);
    if (this.tmp.dot(this.seedDir) > 150 || this.tmp.lengthSq() > 1200 * 1200) this.seed(frame);
    camera.position.copy(this.position);
    this.lookTarget.copy(frame.vel).multiplyScalar(2 / this.look.omega).add(frame.pos);
    this.look.update(this.lookTarget, dt);
    camera.up.copy(WORLD_UP);
    camera.lookAt(this.look.pos);
    const fovT = autoFovDeg(camera.position.distanceTo(frame.pos), this.opts.aircraftLengthM, 0.1, 12, 65);
    this.fovS += (fovT - this.fovS) * expSmoothing(dt, 0.25);
    return this.fovS;
  }
}
