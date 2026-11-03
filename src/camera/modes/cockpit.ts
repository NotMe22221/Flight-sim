/**
 * Cockpit camera: eye at the pilot eye point, free-look (pointer / look axes) with a smooth
 * return to centre, head orientation lagging the aircraft attitude (first-order, τ ≈ 0.08 s)
 * and a g-induced vertical bob (−3 cm per g of (nz − 1), clamped ±5 cm).
 */
import * as THREE from 'three';
import type { CameraState } from '../../core/types';
import { SpringScalar, expSmoothing, omegaFromTau } from '../smoothing';
import type { CameraFrame, CameraModeHandler, ResolvedCameraOptions } from '../types';
import { clamp, quatFromYawPitch } from './util';

export class CockpitMode implements CameraModeHandler {
  private readonly qHead = new THREE.Quaternion();
  private readonly qLook = new THREE.Quaternion();
  private readonly bob = new SpringScalar(omegaFromTau(0.1));
  private readonly tmp = new THREE.Vector3();
  private recentring = false;

  constructor(private readonly state: CameraState, private readonly opts: ResolvedCameraOptions) {}

  enter(frame: CameraFrame): void {
    this.qHead.copy(frame.quat);
    this.bob.reset(0);
  }

  /** Start the smooth return of the free-look offsets to straight ahead. */
  recentre(): void { this.recentring = true; }
  reset(): void { this.recentre(); }

  /** current head bob offset (m, + up), for tests */
  get bobOffset(): number { return this.bob.x; }

  update(frame: CameraFrame, camera: THREE.PerspectiveCamera): number | undefined {
    const o = this.opts, s = this.state, dt = frame.dt;
    if (frame.pointerActive || frame.axisYaw !== 0 || frame.axisPitch !== 0) this.recentring = false;
    s.lookYaw = clamp(s.lookYaw + frame.lookYaw, -o.cockpitYawLimitRad, o.cockpitYawLimitRad);
    s.lookPitch = clamp(s.lookPitch + frame.lookPitch, o.cockpitPitchMinRad, o.cockpitPitchMaxRad);
    if (this.recentring) {
      const k = expSmoothing(dt, o.recentreTauS);
      s.lookYaw -= s.lookYaw * k;
      s.lookPitch -= s.lookPitch * k;
      if (Math.abs(s.lookYaw) < 1e-3 && Math.abs(s.lookPitch) < 1e-3) { s.lookYaw = 0; s.lookPitch = 0; this.recentring = false; }
    }
    // head lags the airframe attitude
    this.qHead.slerp(frame.quat, expSmoothing(dt, o.headLagTauS));
    // g bob along the aircraft's up axis
    const nz = frame.aircraft.loadFactor[2];
    const bobTarget = clamp(-o.gBobMPerG * (nz - 1), -o.gBobMaxM, o.gBobMaxM);
    const bob = this.bob.update(bobTarget, dt);
    this.tmp.copy(frame.eye);
    this.tmp.y += bob;
    camera.position.copy(this.tmp).applyQuaternion(frame.quat).add(frame.pos);
    quatFromYawPitch(s.lookYaw, s.lookPitch, this.qLook);
    camera.quaternion.copy(this.qHead).multiply(this.qLook);
    return undefined; // user FOV
  }
}
