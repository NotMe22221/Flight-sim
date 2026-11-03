/**
 * Cockpit camera: eye at the pilot eye point, free-look (pointer / look axes) with a smooth
 * return to centre, head orientation lagging the aircraft attitude (first-order, τ ≈ 0.08 s)
 * and a head-displacement model (docs/research/01 §6): a second-order spring (ωn ≈ 6 rad/s,
 * ζ ≈ 0.7) per axis driven by the body specific force, 2 cm per g, each axis clamped ±5 cm.
 * The head moves opposite to the felt force: sinks under positive g, swings aft on the
 * take-off roll, sways left when the aircraft skids right.
 */
import * as THREE from 'three';
import type { CameraState } from '../../core/types';
import { DampedSpringScalar, expSmoothing } from '../smoothing';
import type { CameraFrame, CameraModeHandler, ResolvedCameraOptions } from '../types';
import { clamp, quatFromYawPitch } from './util';

const finite = (x: number): number => (Number.isFinite(x) ? x : 0);

export class CockpitMode implements CameraModeHandler {
  private readonly qHead = new THREE.Quaternion();
  private readonly qLook = new THREE.Quaternion();
  private readonly springX: DampedSpringScalar;
  private readonly springY: DampedSpringScalar;
  private readonly springZ: DampedSpringScalar;
  private readonly offset = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private recentring = false;

  constructor(private readonly state: CameraState, private readonly opts: ResolvedCameraOptions) {
    const w = opts.headSpringOmega, z = opts.headSpringZeta;
    this.springX = new DampedSpringScalar(w, z);
    this.springY = new DampedSpringScalar(w, z);
    this.springZ = new DampedSpringScalar(w, z);
  }

  enter(frame: CameraFrame): void {
    this.qHead.copy(frame.quat);
    this.springX.reset(0); this.springY.reset(0); this.springZ.reset(0);
    this.offset.set(0, 0, 0);
  }

  snap(frame: CameraFrame): void { this.enter(frame); }

  /** Start the smooth return of the free-look offsets to straight ahead. */
  recentre(): void { this.recentring = true; }
  reset(): void { this.recentre(); }

  /** Current head displacement from the eye point, model-local metres (live; do not mutate). */
  get headOffset(): THREE.Vector3 { return this.offset; }
  /** Vertical part of {@link headOffset} (m, + up). */
  get bobOffset(): number { return this.offset.y; }

  private updateHead(frame: CameraFrame): void {
    const o = this.opts, dt = frame.dt, k = o.gBobMPerG, lim = o.gBobMaxM;
    const n = frame.aircraft.loadFactor;
    // body specific force (nx fwd, ny right, nz up-through-the-seat) → model axes (x right, y up, z aft)
    const tx = clamp(-k * finite(n[1]), -lim, lim);
    const ty = clamp(-k * (finite(n[2]) - 1), -lim, lim);
    const tz = clamp(k * finite(n[0]), -lim, lim);
    this.offset.set(
      clamp(this.springX.update(tx, dt), -lim, lim),
      clamp(this.springY.update(ty, dt), -lim, lim),
      clamp(this.springZ.update(tz, dt), -lim, lim),
    );
  }

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
    this.updateHead(frame);
    this.tmp.copy(frame.eye).add(this.offset);
    camera.position.copy(this.tmp).applyQuaternion(frame.quat).add(frame.pos);
    quatFromYawPitch(s.lookYaw, s.lookPitch, this.qLook);
    camera.quaternion.copy(this.qHead).multiply(this.qLook);
    return undefined; // user FOV
  }
}
