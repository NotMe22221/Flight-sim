/**
 * External orbit camera: orbits the aircraft at `orbitDistanceM` (8..200 m, cameraZoom axis),
 * yaw/pitch from pointer drag (relative to the smoothed aircraft heading, so it follows the
 * aircraft round turns) with inertia after the drag is released.
 */
import * as THREE from 'three';
import type { CameraState } from '../../core/types';
import { expSmoothing, smoothAngle } from '../smoothing';
import type { CameraFrame, CameraModeHandler, ResolvedCameraOptions } from '../types';
import { WORLD_UP, clamp, clampAboveGround } from './util';

const D2R = Math.PI / 180;

export class OrbitMode implements CameraModeHandler {
  private yawVel = 0;
  private pitchVel = 0;
  private headingS = 0;
  private readonly lookPt = new THREE.Vector3();

  constructor(private readonly state: CameraState, private readonly opts: ResolvedCameraOptions) {}

  enter(frame: CameraFrame): void {
    this.headingS = frame.heading;
    this.yawVel = 0; this.pitchVel = 0;
    const s = this.state;
    s.orbitDistanceM = clamp(s.orbitDistanceM || this.opts.chaseDistanceM, this.opts.orbitMinM, this.opts.orbitMaxM);
  }

  reset(): void {
    this.state.orbitYaw = 0;
    this.state.orbitPitch = 12 * D2R;
    this.state.orbitDistanceM = clamp(this.opts.chaseDistanceM, this.opts.orbitMinM, this.opts.orbitMaxM);
    this.yawVel = 0; this.pitchVel = 0;
  }

  /** angular velocities (rad/s), for tests */
  get yawVelocity(): number { return this.yawVel; }

  update(frame: CameraFrame, camera: THREE.PerspectiveCamera): number | undefined {
    const s = this.state, o = this.opts, dt = frame.dt;
    let dYaw = frame.axisYaw, dPitch = frame.axisPitch;
    if (frame.pointerActive && dt > 1e-5) {
      dYaw += frame.pointerYaw; dPitch += frame.pointerPitch;
      this.yawVel = frame.pointerYaw / dt;
      this.pitchVel = frame.pointerPitch / dt;
    } else {
      const k = Math.exp(-dt / o.orbitInertiaTauS);
      this.yawVel *= k; this.pitchVel *= k;
      dYaw += this.yawVel * dt; dPitch += this.pitchVel * dt;
      if (Math.abs(this.yawVel) < 1e-4) this.yawVel = 0;
      if (Math.abs(this.pitchVel) < 1e-4) this.pitchVel = 0;
    }
    s.orbitYaw += dYaw;
    if (s.orbitYaw > Math.PI) s.orbitYaw -= 2 * Math.PI; else if (s.orbitYaw < -Math.PI) s.orbitYaw += 2 * Math.PI;
    s.orbitPitch = clamp(s.orbitPitch + dPitch, -10 * D2R, 85 * D2R);
    s.orbitDistanceM = clamp(s.orbitDistanceM * Math.exp(-frame.zoomAxis * dt * 1.2), o.orbitMinM, o.orbitMaxM);

    this.headingS = smoothAngle(this.headingS, frame.heading, expSmoothing(dt, 0.3));
    const az = this.headingS + Math.PI + s.orbitYaw;
    const cp = Math.cos(s.orbitPitch), d = s.orbitDistanceM;
    camera.position.set(frame.pos.x + Math.sin(az) * cp * d, frame.pos.y + Math.sin(s.orbitPitch) * d, frame.pos.z - Math.cos(az) * cp * d);
    clampAboveGround(camera.position, o);
    this.lookPt.copy(frame.pos);
    this.lookPt.y += 0.3;
    camera.up.copy(WORLD_UP);
    camera.lookAt(this.lookPt);
    return undefined;
  }
}
