/**
 * Drone (free) camera. Translation from InputSnapshot axes (see {@link DroneAxisMap}): by
 * default stick forward (pitch −1) flies forward along the view, roll strafes right, and the
 * throttle moves up/down relative to where it was when the drone was entered. Yaw/pitch come
 * from the pointer and look axes. Optional follow mode keeps the offset from the aircraft in
 * the aircraft's heading frame and turns the view with the heading, so the drone flies
 * formation.
 */
import * as THREE from 'three';
import type { CameraState } from '../../core/types';
import { threeVecToNed } from '../../aircraft3d/frames';
import type { CameraFrame, CameraModeHandler, ResolvedCameraOptions } from '../types';
import { Y_AXIS, clamp, clampAboveGround, dirFromYaw, quatFromYawPitch, yawOf } from './util';

const D2R = Math.PI / 180;
const wrapPi = (a: number): number => (a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a);

export class DroneMode implements CameraModeHandler {
  readonly position = new THREE.Vector3();
  private follow = false;
  private captureOffset = false;
  private speedMs: number;
  private verticalCentre = 0;
  private lastHeading = 0;
  private readonly offsetLocal = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly qH = new THREE.Quaternion();
  private readonly qHInv = new THREE.Quaternion();

  constructor(private readonly state: CameraState, private readonly opts: ResolvedCameraOptions) {
    this.speedMs = opts.droneBaseSpeedMs;
  }

  enter(frame: CameraFrame, camera: THREE.PerspectiveCamera): void {
    this.position.copy(camera.position);
    camera.getWorldDirection(this.fwd);
    this.state.droneYaw = yawOf(this.fwd);
    this.state.dronePitch = Math.asin(clamp(this.fwd.y, -1, 1));
    const m = this.opts.droneAxes;
    const a = frame.input.axes[m.vertical];
    this.verticalCentre = m.verticalCentre === 'entry' ? (Number.isFinite(a) ? a : 0) : m.verticalCentre;
    this.lastHeading = frame.heading;
    if (this.follow) this.captureOffset = true;
  }

  /** After a teleport: hover 30 m behind and 10 m above the aircraft, looking at it. */
  snap(frame: CameraFrame): void {
    this.position.copy(frame.pos).addScaledVector(frame.forwardH, -30);
    this.position.y += 10;
    this.tmp.subVectors(frame.pos, this.position).normalize();
    this.state.droneYaw = yawOf(this.tmp);
    this.state.dronePitch = Math.asin(clamp(this.tmp.y, -1, 1));
    this.lastHeading = frame.heading;
    if (this.follow) this.captureOffset = true;
  }

  shiftOrigin(delta: THREE.Vector3): void { this.position.add(delta); }

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

  /** Translation speed at full axis deflection, m/s (clamped 0.5..1000). */
  setSpeed(ms: number): void { if (Number.isFinite(ms)) this.speedMs = clamp(ms, 0.5, 1000); }
  get speed(): number { return this.speedMs; }

  reset(): void {
    this.state.dronePitch = 0;
  }

  update(frame: CameraFrame, camera: THREE.PerspectiveCamera): number | undefined {
    const s = this.state, o = this.opts, dt = frame.dt;
    // in follow mode the view turns with the aircraft heading (formation flying)
    if (this.follow) s.droneYaw += wrapPi(frame.heading - this.lastHeading);
    this.lastHeading = frame.heading;
    s.droneYaw = wrapPi(s.droneYaw + frame.lookYaw);
    s.dronePitch = clamp(s.dronePitch + frame.lookPitch, -89 * D2R, 89 * D2R);

    // view axes
    const cp = Math.cos(s.dronePitch);
    this.fwd.set(Math.sin(s.droneYaw) * cp, Math.sin(s.dronePitch), -Math.cos(s.droneYaw) * cp);
    dirFromYaw(s.droneYaw + Math.PI / 2, this.right);

    // translation
    const ax = frame.input.axes, m = o.droneAxes;
    const f = m.forwardSign * clamp(ax[m.forward] || 0, -1, 1);
    const st = clamp(ax[m.strafe] || 0, -1, 1);
    let v = (ax[m.vertical] || 0) - this.verticalCentre;
    v = Math.abs(v) < m.verticalDeadband ? 0 : clamp(v / m.verticalRange, -1, 1);
    const speed = this.speedMs;
    this.vel.set(0, 0, 0).addScaledVector(this.fwd, f * speed).addScaledVector(this.right, st * speed);
    this.vel.y += v * speed;

    // heading frame: world = R_y(−ψ) · local
    this.qH.setFromAxisAngle(Y_AXIS, -frame.heading);
    if (this.follow) {
      this.qHInv.copy(this.qH).invert();
      if (this.captureOffset) {
        this.offsetLocal.subVectors(this.position, frame.pos).applyQuaternion(this.qHInv);
        this.captureOffset = false;
      }
      this.tmp.copy(this.vel).multiplyScalar(dt).applyQuaternion(this.qHInv);
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
