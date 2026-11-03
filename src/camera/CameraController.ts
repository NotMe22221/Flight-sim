/**
 * CameraController: owns the PerspectiveCamera and the CameraState, dispatches to one mode
 * handler per CameraMode and applies the common input handling (pointer free-look, look
 * axes, zoom, camera actions). All smoothing is frame-rate independent and no per-frame
 * allocations are made.
 *
 * Frame: positions/quaternions are in the Three.js render frame (x East, y Up, z South);
 * the integrator converts the FDM pose with `src/aircraft3d/frames.ts`.
 */
import * as THREE from 'three';
import type { AircraftState, CameraMode, CameraState, InputSnapshot, SimAction } from '../core/types';
import { CockpitMode } from './modes/cockpit';
import { ChaseMode } from './modes/chase';
import { OrbitMode } from './modes/orbit';
import { DroneMode } from './modes/drone';
import { TowerMode } from './modes/tower';
import { FlybyMode } from './modes/flyby';
import { WingMode } from './modes/wing';
import { dirFromYaw, yawOf } from './modes/util';
import { resolveCameraOptions, type CameraFrame, type CameraModeHandler, type CameraOptions, type ResolvedCameraOptions } from './types';

const D2R = Math.PI / 180;
const MODE_ORDER: readonly CameraMode[] = ['cockpit', 'chase', 'external-orbit', 'drone', 'tower', 'flyby', 'wing'];
const NOSE = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  readonly state: CameraState;
  readonly options: ResolvedCameraOptions;
  readonly cockpit: CockpitMode;
  readonly chase: ChaseMode;
  readonly orbit: OrbitMode;
  readonly drone: DroneMode;
  readonly tower: TowerMode;
  readonly flyby: FlybyMode;
  readonly wing: WingMode;

  private readonly handlers: Record<CameraMode, CameraModeHandler>;
  private userFovDeg: number;
  private pendingEnter = true;
  private pendingSnap = false;
  /** zoomIn (+1) / zoomOut (−1) steps requested since the last update */
  private pendingZoomSteps = 0;
  private lastFov = -1;
  private lastNear = -1;
  private readonly frame: CameraFrame;
  private readonly velScratch = new THREE.Vector3();

  constructor(aspect: number, options: CameraOptions = {}) {
    this.options = resolveCameraOptions(options);
    const o = this.options;
    this.camera = new THREE.PerspectiveCamera(o.defaultFovDeg, aspect, o.nearCockpitM, o.farM);
    this.camera.name = 'simCamera';
    this.userFovDeg = o.defaultFovDeg;
    this.state = {
      mode: 'cockpit', lookYaw: 0, lookPitch: 0,
      orbitYaw: 0, orbitPitch: 12 * D2R, orbitDistanceM: Math.min(o.orbitMaxM, Math.max(o.orbitMinM, o.chaseDistanceM)),
      fovDeg: o.defaultFovDeg, dronePosNED: [0, 0, 0], droneYaw: 0, dronePitch: 0,
    };
    this.cockpit = new CockpitMode(this.state, o);
    this.chase = new ChaseMode(this.state, o);
    this.orbit = new OrbitMode(this.state, o);
    this.drone = new DroneMode(this.state, o);
    this.tower = new TowerMode(o);
    this.flyby = new FlybyMode(o);
    this.wing = new WingMode();
    this.handlers = {
      cockpit: this.cockpit, chase: this.chase, 'external-orbit': this.orbit, drone: this.drone,
      tower: this.tower, flyby: this.flyby, wing: this.wing,
    };
    this.frame = {
      dt: 0, aircraft: undefined as unknown as AircraftState, pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
      input: undefined as unknown as InputSnapshot, eye: new THREE.Vector3(),
      forward: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3(),
      forwardH: new THREE.Vector3(), velDirH: new THREE.Vector3(), vel: new THREE.Vector3(),
      heading: 0, roll: 0, lookYaw: 0, lookPitch: 0, pointerYaw: 0, pointerPitch: 0, axisYaw: 0, axisPitch: 0,
      pointerActive: false, zoomAxis: 0, zoomSteps: 0,
    };
  }

  /** Current mode. */
  get mode(): CameraMode { return this.state.mode; }
  get isCockpit(): boolean { return this.state.mode === 'cockpit'; }

  /** Switch mode; the new mode starts from the previous camera pose where that makes sense. */
  setMode(mode: CameraMode): void {
    if (mode === this.state.mode && !this.pendingEnter) return;
    this.state.mode = mode;
    this.pendingEnter = true;
    this.options.onModeChange?.(mode);
  }

  /** Cycle through the modes (cameraNext). */
  cycleMode(step = 1): void {
    const i = MODE_ORDER.indexOf(this.state.mode);
    this.setMode(MODE_ORDER[(i + step + MODE_ORDER.length) % MODE_ORDER.length]);
  }

  /** Smoothly return cockpit free-look to straight ahead. */
  recentre(): void { this.cockpit.recentre(); }

  /** User field of view (deg) used by cockpit/chase/orbit/drone/wing; tower and flyby auto-zoom. */
  get fovDeg(): number { return this.userFovDeg; }
  setFov(deg: number): void {
    if (!Number.isFinite(deg)) return;
    this.userFovDeg = Math.min(this.options.maxFovDeg, Math.max(this.options.minFovDeg, deg));
  }
  /**
   * One zoom step (a wheel notch / key press), applied on the next update: cockpit, drone and
   * wing narrow the FOV by `fovStepDeg`; chase and orbit move in by `distanceStep`.
   */
  zoomIn(): void { this.pendingZoomSteps += 1; }
  zoomOut(): void { this.pendingZoomSteps -= 1; }

  /** Fixed tower position (render frame). Unset towers seed themselves 300 m left / 20 m above the aircraft. */
  setTowerPosition(posThree: THREE.Vector3): void { this.tower.setPosition(posThree); }
  /** Drone follow mode: keep the current offset from the aircraft (in its heading frame). */
  setDroneFollow(on: boolean): void { this.drone.setFollow(on); }
  get droneFollow(): boolean { return this.drone.following; }
  /** Drone translation speed at full axis deflection, m/s. */
  setDroneSpeed(ms: number): void { this.drone.setSpeed(ms); }

  /**
   * The render-frame origin moved (floating-origin rebase): every world position is now
   * `old + delta`. Shifts the world-anchored camera state (tower, fly-by point, drone, look-at
   * springs) so nothing swings. Call it in the same frame the world/aircraft are rebased.
   */
  shiftOrigin(delta: THREE.Vector3): void {
    if (!Number.isFinite(delta.x + delta.y + delta.z)) return;
    for (const m of MODE_ORDER) this.handlers[m].shiftOrigin?.(delta);
    this.camera.position.add(delta);
  }

  /**
   * After a teleport / flight reset: re-seed the tower from the aircraft and jump the active
   * mode straight to its steady-state pose on the next update (no spring swing across the map).
   */
  snapToAircraft(): void {
    this.tower.unseed();
    this.pendingSnap = true;
  }
  /** Pick a new fly-by point now. */
  reseedFlyby(): void { if (this.state.mode === 'flyby') this.flyby.seed(this.frame); }

  /** Respond to a camera-related action (also done automatically from InputSnapshot.actions). */
  handleAction(action: SimAction): boolean {
    switch (action) {
      case 'cameraCockpit': this.setMode('cockpit'); return true;
      case 'cameraChase': this.setMode('chase'); return true;
      case 'cameraExternal': this.setMode('external-orbit'); return true;
      case 'cameraDrone': this.setMode('drone'); return true;
      case 'cameraTower': this.setMode('tower'); return true;
      case 'cameraNext': this.cycleMode(1); return true;
      case 'cameraReset': this.handlers[this.state.mode].reset?.(this.frame); return true;
      case 'zoomIn': this.zoomIn(); return true;
      case 'zoomOut': this.zoomOut(); return true;
      default: return false;
    }
  }

  /**
   * Advance the camera one render frame.
   * @param dt            real seconds since the previous frame (clamped to 0.25)
   * @param aircraft      latest (interpolated) aircraft state
   * @param aircraftPosThree / aircraftQuatThree  render-frame pose (see aircraft3d/frames.ts)
   * @param input         this frame's input snapshot (pointer deltas, look/zoom axes, actions)
   * @param eyePointLocal pilot eye point in the model frame (AircraftModel.eyePointLocal)
   */
  update(
    dt: number,
    aircraft: AircraftState,
    aircraftPosThree: THREE.Vector3,
    aircraftQuatThree: THREE.Quaternion,
    input: InputSnapshot,
    eyePointLocal: THREE.Vector3,
  ): void {
    const f = this.frame, o = this.options;
    // A non-finite sample would poison every spring for good: keep the last good camera pose.
    const p = aircraftPosThree, q = aircraftQuatThree;
    if (!Number.isFinite(p.x + p.y + p.z + q.x + q.y + q.z + q.w)) return;
    // NaN / negative → 0; clamp like the main loop
    f.dt = dt > 0 ? (dt > 0.25 ? 0.25 : dt) : 0;
    f.aircraft = aircraft;
    f.input = input;
    f.pos.copy(p);
    f.quat.copy(q);
    f.eye.copy(eyePointLocal);
    f.forward.copy(NOSE).applyQuaternion(f.quat);
    f.up.copy(UP).applyQuaternion(f.quat);
    f.right.copy(RIGHT).applyQuaternion(f.quat);
    f.forwardH.set(f.forward.x, 0, f.forward.z);
    const h = aircraft.headingTrueRad;
    const nearVertical = f.forwardH.lengthSq() < 1e-6;
    if (!nearVertical) f.forwardH.normalize();
    f.heading = Number.isFinite(h) ? h : nearVertical ? 0 : yawOf(f.forwardH);
    if (nearVertical) dirFromYaw(f.heading, f.forwardH);
    const r = aircraft.euler[0];
    f.roll = Number.isFinite(r) ? r : 0;
    const v = aircraft.velNED;
    f.vel.set(v[1], -v[2], -v[0]);
    if (!Number.isFinite(f.vel.x + f.vel.y + f.vel.z)) f.vel.set(0, 0, 0);
    this.velScratch.set(f.vel.x, 0, f.vel.z);
    if (this.velScratch.lengthSq() > 9) f.velDirH.copy(this.velScratch).normalize(); else f.velDirH.copy(f.forwardH);

    // look input (`|| 0` maps NaN to 0); + yaw = look right, + pitch = look up
    const pdx = input.pointerDx || 0, pdy = input.pointerDy || 0;
    f.pointerActive = pdx !== 0 || pdy !== 0;
    f.pointerYaw = pdx * o.pointerSensitivity;
    f.pointerPitch = -pdy * o.pointerSensitivity;
    f.axisYaw = (input.axes.lookYaw || 0) * o.lookRateRadS * f.dt;
    f.axisPitch = (input.axes.lookPitch || 0) * o.lookRateRadS * f.dt;
    f.lookYaw = f.pointerYaw + f.axisYaw;
    f.lookPitch = f.pointerPitch + f.axisPitch;
    const z = input.axes.cameraZoom || 0;
    f.zoomAxis = z < -1 ? -1 : z > 1 ? 1 : z;

    if (o.consumeActions) {
      const actions = input.actions;
      for (let i = 0; i < actions.length; i++) this.handleAction(actions[i]);
    }
    f.zoomSteps = this.pendingZoomSteps;
    this.pendingZoomSteps = 0;
    const mode = this.state.mode;
    if (mode === 'cockpit' || mode === 'drone' || mode === 'wing') {
      // FOV modes: a step per action, continuous while the zoom axis is held (+ = zoom in)
      this.setFov(this.userFovDeg - f.zoomSteps * o.fovStepDeg - f.zoomAxis * o.fovRateDegS * f.dt);
    }

    // tower is seeded relative to the spawn point on the very first frame
    if (!this.tower.isSeeded) this.tower.seedFromAircraft(f);

    const handler = this.handlers[mode];
    if (this.pendingEnter) { handler.enter(f, this.camera); this.pendingEnter = false; }
    if (this.pendingSnap) { handler.snap?.(f, this.camera); this.pendingSnap = false; }
    const fov = handler.update(f, this.camera) ?? this.userFovDeg;
    this.state.fovDeg = fov;
    // the wing camera sits 0.4 m above the skin: it needs the cockpit near plane too
    const near = mode === 'cockpit' || mode === 'wing' ? o.nearCockpitM : o.nearExternalM;
    if (fov !== this.lastFov || near !== this.lastNear) {
      this.camera.fov = fov;
      this.camera.near = near;
      this.camera.far = o.farM;
      this.camera.updateProjectionMatrix();
      this.lastFov = fov; this.lastNear = near;
    }
  }

  /** New viewport aspect (width / height); ignored unless finite and > 0 (e.g. a 0-height canvas). */
  handleResize(aspect: number): void {
    if (!(aspect > 0) || !Number.isFinite(aspect)) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Live reference to the camera position in the render frame (do not mutate). */
  positionThree(): THREE.Vector3 { return this.camera.position; }
}
