/**
 * Drone (free) camera. Translation from InputSnapshot axes (see {@link DroneAxisMap}:
 * by default axes.pitch → forward along the view, axes.roll → strafe right, axes.throttle
 * (centred at 0.5) → up/down), yaw/pitch from pointer and look axes, speed = base × 8^cameraZoom.
 * Optional follow mode keeps the offset from the aircraft, expressed in the aircraft's
 * heading frame, so the drone flies formation.
 */
import * as THREE from 'three';
import type { CameraState } from '../../core/types';
import { threeVecToNed } from '../../aircraft3d/frames';
import type { CameraFrame, CameraModeHandler, ResolvedCameraOptions } from '../types';
import { Y_AXIS, clamp, clampAboveGround, dirFromYaw, quatFromYawPitch, yawOf } from './util';

const D2R = Math.PI / 180;

export class DroneMode implements CameraModeHandler {
  readonly position = new THREE.Vector3();
  private follow = false;
  private captureOffset = false;
  private readonly offsetLocal = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly qH = new THREE.Quaternion();

  constructor(private readonly state: CameraState, private readonly opts: ResolvedCameraOptions) {}

  enter(frame: CameraFrame, camera: THREE.PerspectiveCamera): void {
    this.position.copy(camera.position);
    camera.getWorldDirection(this.fwd);
    this.state.droneYaw = yawOf(this.fwd);
    this.state.dronePitch = Math.asin(clamp(this.fwd.y, -1, 1));
    if (this.follow) this.captureOffset = true;
  }

  /** Place the drone explicitly (render frame). */
  setPosition(p: THREE.Vector3): void {
    this.position.copy(p);
    if (this.follow) this.captureOffset = true;
  }

  setFollow(on: boolean): void {
    this.follow = on;
    if (on) this.captureOffset = true;
  }
  get following(): boolean { return this.follow; }

  reset(): void {
    this.state.dronePitch = 0;
  }

  update(frame: CameraFrame, camera: THREE.PerspectiveCamera): number | undefined {
    const s = this.state, o = this.opts, dt = frame.dt;
    s.droneYaw += frame.lookYaw;
    if (s.droneYaw > Math.PI) s.droneYaw -= 2 * Math.PI; else if (s.droneYaw < -Math.PI) s.droneYaw += 2 * Math.PI;
    s.dronePitch = clamp(s.dronePitch + frame.lookPitch, -89 * D2R, 89 * D2R);

    // view axes
    const cp = Math.cos(s.dronePitch);
    this.fwd.set(Math.sin(s.droneYaw) * cp, Math.sin(s.dronePitch), -Math.cos(s.droneYaw) * cp);
    dirFromYaw(s.droneYaw + Math.PI / 2, this.right);

    // translation
    const ax = frame.input.axes, m = o.droneAxes;
    const speed = o.droneBaseSpeedMs * Math.pow(8, frame.zoomAxis);
    const f = clamp(ax[m.forward], -1, 1);
    const st = clamp(ax[m.strafe], -1, 1);
    let v = ax[m.vertical] - m.verticalCentre;
    v = Math.abs(v) < m.verticalDeadband ? 0 : clamp(v / (1 - m.verticalCentre), -1, 1);
    this.vel.set(0, 0, 0).addScaledVector(this.fwd, f * speed).addScaledVector(this.right, st * speed);
    this.vel.y += v * speed;

    // heading frame: world = R_y(−ψ) · local
    this.qH.setFromAxisAngle(Y_AXIS, -frame.heading);
    if (this.follow) {
      if (this.captureOffset) {
        this.offsetLocal.subVectors(this.position, frame.pos).applyQuaternion(this.qH.conjugate());
        this.qH.conjugate();
        this.captureOffset = false;
      }
      this.tmp.copy(this.vel).multiplyScalar(dt).applyQuaternion(this.qH.conjugate());
      this.qH.conjugate();
      this.offsetLocal.add(this.tmp);
      this.position.copy(this.offsetLocal).applyQuaternion(this.qH).add(frame.pos);
    } else {
      this.position.addScaledVector(this.vel, dt);
    }
    clampAboveGround(this.position, o);
    camera.position.copy(this.position);
    quatFromYawPitch(s.droneYaw, s.dronePitch, camera.quaternion);
    threeVecToNed(this.position, s.dronePosNED);
    return undefined;
  }
}
