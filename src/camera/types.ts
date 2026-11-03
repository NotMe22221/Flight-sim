/**
 * Camera module types: tuning options and the per-frame context handed to each mode.
 */
import type * as THREE from 'three';
import type { AircraftState, CameraMode, InputSnapshot, SimAxis } from '../core/types';

/** Which InputSnapshot axes translate the drone camera. */
export interface DroneAxisMap {
  /** axis for forward/back; default 'pitch' */
  forward: SimAxis;
  /**
   * sign applied to `forward` so that + moves along the view. Default −1: pushing the stick
   * forward gives pitch −1 (nose down, docs/research/06 B5) and must fly the drone forward.
   */
  forwardSign: 1 | -1;
  /** axis for strafe (+ = right); default 'roll' */
  strafe: SimAxis;
  /** axis for vertical; default 'throttle' */
  vertical: SimAxis;
  /**
   * value of `vertical` that means "no vertical motion". 'entry' (default) captures the axis
   * value when the drone is entered, so an idle or cruise throttle does not make it sink or
   * climb; use 0 for a ±1 axis.
   */
  verticalCentre: number | 'entry';
  /** axis travel from the centre that gives full vertical speed (0.5 for a 0..1 throttle, 1 for ±1) */
  verticalRange: number;
  /** dead band around the centre, axis units */
  verticalDeadband: number;
}

export interface CameraOptions {
  /** overall aircraft length, scales chase distance / auto-FOV (default 8.28) */
  aircraftLengthM?: number;
  /** default field of view, deg (default 70) */
  defaultFovDeg?: number;
  /** user FOV limits for cockpit / drone / wing (default 30°..90°, docs/research/06 B4.1) */
  minFovDeg?: number;
  maxFovDeg?: number;
  /** FOV change per zoomIn/zoomOut action in cockpit / drone / wing (default 5°) */
  fovStepDeg?: number;
  /** chase / orbit distance factor per zoomOut action (zoomIn divides; default 1.1) */
  distanceStep?: number;
  /** held cameraZoom axis (+1 = zoom in): FOV rate, deg/s (default 40) */
  fovRateDegS?: number;
  /** held cameraZoom axis: distance e-folding rate, 1/s (default 1.2) */
  distanceRatePerS?: number;
  /** far plane (default 600 km) */
  farM?: number;
  /** near plane in the cockpit (default 0.05) / outside (default 0.5) */
  nearCockpitM?: number;
  nearExternalM?: number;
  /** free-look sensitivity, rad per pointer pixel (default 0.0025) */
  pointerSensitivity?: number;
  /** free-look rate for the lookYaw/lookPitch axes, rad/s at full deflection (default 2.0) */
  lookRateRadS?: number;
  /** time constant of the return-to-centre tween (default 0.12 s) */
  recentreTauS?: number;
  /**
   * Neutral head pitch in the cockpit, added to the free-look pitch (default −3.5°: like the
   * MSFS default view, the pilot looks slightly down so the whole six-pack is on screen with
   * the horizon above the glareshield). Recentring returns to this pose.
   */
  cockpitNeutralPitchRad?: number;
  /** cockpit free-look limits (default ±160°, −60°/+80°) */
  cockpitYawLimitRad?: number;
  cockpitPitchMinRad?: number;
  cockpitPitchMaxRad?: number;
  /** head orientation lags the aircraft attitude with this time constant (default 0.08 s) */
  headLagTauS?: number;
  /**
   * Head displacement opposite to the body specific force: m per g of (nx, ny, nz − 1)
   * (default 0.02 = ±2 cm/g, docs/research/01 §6), each axis clamped to ±gBobMaxM (0.05 m).
   */
  gBobMPerG?: number;
  gBobMaxM?: number;
  /** head spring natural frequency (default 6 rad/s) and damping ratio (default 0.7) */
  headSpringOmega?: number;
  headSpringZeta?: number;
  /**
   * initial chase / orbit distance (default 2 × aircraft length ≈ 16.6 m: like the MSFS default
   * external view, the aircraft spans about a third of the frame width at 70° FOV); zoom changes it
   */
  chaseDistanceM?: number;
  /** chase elevation angle above the aircraft (default 12°) */
  chaseElevationRad?: number;
  /** chase position / look-at spring lags (default 0.35 s / 0.15 s) */
  chasePosTauS?: number;
  chaseLookTauS?: number;
  /** fraction of the aircraft roll the chase camera follows (default 0.3) */
  chaseRollFollow?: number;
  /** orbit distance limits (default 8..200 m) and inertia time constant on release (default 0.4 s) */
  orbitMinM?: number;
  orbitMaxM?: number;
  orbitInertiaTauS?: number;
  /** drone translation speed at full axis deflection, m/s (default 20; see setDroneSpeed) */
  droneBaseSpeedMs?: number;
  droneAxes?: Partial<DroneAxisMap>;
  /** tower auto-FOV: aircraft length as a fraction of the frame height (default 0.14, ≈ 100 px at 720 p) */
  towerFrameFraction?: number;
  /** tower FOV limits (default 2°..60°) and FOV smoothing (default 0.4 s) */
  towerMinFovDeg?: number;
  towerMaxFovDeg?: number;
  towerFovTauS?: number;
  /** flyby seed geometry (default 400 m ahead, 50 m to the side) */
  flybyAheadM?: number;
  flybySideM?: number;
  /** optional terrain query (render-frame x, z → ground y) used to keep external cameras above ground */
  groundHeightThree?: (x: number, z: number) => number;
  /** minimum height above the ground for external cameras (default 1.5 m) */
  groundClearanceM?: number;
  /** react to camera* / zoom* / cameraReset actions in the InputSnapshot (default true) */
  consumeActions?: boolean;
  /** called after every mode change */
  onModeChange?: (mode: CameraMode) => void;
}

export type ResolvedCameraOptions = Required<Omit<CameraOptions, 'droneAxes' | 'groundHeightThree' | 'onModeChange'>> & {
  droneAxes: DroneAxisMap;
  groundHeightThree?: (x: number, z: number) => number;
  onModeChange?: (mode: CameraMode) => void;
};

const D2R = Math.PI / 180;

export function resolveCameraOptions(o: CameraOptions): ResolvedCameraOptions {
  const length = o.aircraftLengthM ?? 8.28;
  return {
    aircraftLengthM: length,
    defaultFovDeg: o.defaultFovDeg ?? 70,
    minFovDeg: o.minFovDeg ?? 30,
    maxFovDeg: o.maxFovDeg ?? 90,
    fovStepDeg: o.fovStepDeg ?? 5,
    distanceStep: o.distanceStep ?? 1.1,
    fovRateDegS: o.fovRateDegS ?? 40,
    distanceRatePerS: o.distanceRatePerS ?? 1.2,
    farM: o.farM ?? 600_000,
    nearCockpitM: o.nearCockpitM ?? 0.05,
    nearExternalM: o.nearExternalM ?? 0.5,
    pointerSensitivity: o.pointerSensitivity ?? 0.0025,
    lookRateRadS: o.lookRateRadS ?? 2.0,
    recentreTauS: o.recentreTauS ?? 0.12,
    cockpitNeutralPitchRad: o.cockpitNeutralPitchRad ?? -3.5 * D2R,
    cockpitYawLimitRad: o.cockpitYawLimitRad ?? 160 * D2R,
    cockpitPitchMinRad: o.cockpitPitchMinRad ?? -60 * D2R,
    cockpitPitchMaxRad: o.cockpitPitchMaxRad ?? 80 * D2R,
    headLagTauS: o.headLagTauS ?? 0.08,
    gBobMPerG: o.gBobMPerG ?? 0.02,
    gBobMaxM: o.gBobMaxM ?? 0.05,
    headSpringOmega: o.headSpringOmega ?? 6,
    headSpringZeta: o.headSpringZeta ?? 0.7,
    chaseDistanceM: o.chaseDistanceM ?? 2 * length,
    chaseElevationRad: o.chaseElevationRad ?? 12 * D2R,
    chasePosTauS: o.chasePosTauS ?? 0.35,
    chaseLookTauS: o.chaseLookTauS ?? 0.15,
    chaseRollFollow: o.chaseRollFollow ?? 0.3,
    orbitMinM: o.orbitMinM ?? 8,
    orbitMaxM: o.orbitMaxM ?? 200,
    orbitInertiaTauS: o.orbitInertiaTauS ?? 0.4,
    droneBaseSpeedMs: o.droneBaseSpeedMs ?? 20,
    droneAxes: {
      forward: 'pitch', forwardSign: -1, strafe: 'roll', vertical: 'throttle',
      verticalCentre: 'entry', verticalRange: 0.5, verticalDeadband: 0.03, ...o.droneAxes,
    },
    towerFrameFraction: o.towerFrameFraction ?? 0.14,
    towerMinFovDeg: o.towerMinFovDeg ?? 2,
    towerMaxFovDeg: o.towerMaxFovDeg ?? 60,
    towerFovTauS: o.towerFovTauS ?? 0.4,
    flybyAheadM: o.flybyAheadM ?? 400,
    flybySideM: o.flybySideM ?? 50,
    groundHeightThree: o.groundHeightThree,
    groundClearanceM: o.groundClearanceM ?? 1.5,
    consumeActions: o.consumeActions ?? true,
    onModeChange: o.onModeChange,
  };
}

/**
 * Everything a mode needs for one update. Owned by the controller; the derived vectors are
 * scratch objects refreshed each frame (never retain references across frames).
 */
export interface CameraFrame {
  dt: number;
  aircraft: AircraftState;
  /** aircraft position / orientation in the render frame */
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  input: InputSnapshot;
  /** pilot eye point, model-local */
  eye: THREE.Vector3;
  /** aircraft axes in world (render) space */
  forward: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
  /** horizontal unit forward and horizontal velocity direction (falls back to forwardH when slow) */
  forwardH: THREE.Vector3;
  velDirH: THREE.Vector3;
  /** inertial velocity in the render frame, m/s */
  vel: THREE.Vector3;
  /** compass heading rad (clockwise from north) and roll rad */
  heading: number;
  roll: number;
  /** look input this frame in rad (pointer + axes); +yaw = right, +pitch = up */
  lookYaw: number;
  lookPitch: number;
  /** the pointer and axis parts separately (orbit inertia uses only the pointer part) */
  pointerYaw: number;
  pointerPitch: number;
  axisYaw: number;
  axisPitch: number;
  /** true when the pointer moved this frame (cancels recentring, drives orbit inertia) */
  pointerActive: boolean;
  /** held cameraZoom axis, −1..1, + = zoom in (a rate: hold to keep zooming) */
  zoomAxis: number;
  /** zoomIn / zoomOut actions this frame: + per zoomIn, − per zoomOut (each is one step) */
  zoomSteps: number;
}

/** Interface implemented by each camera mode. */
export interface CameraModeHandler {
  /** called when the mode becomes active; `camera` holds the previous mode's pose */
  enter(frame: CameraFrame, camera: THREE.PerspectiveCamera): void;
  /** write camera.position / camera.quaternion; return a fov (deg) or undefined for the user FOV */
  update(frame: CameraFrame, camera: THREE.PerspectiveCamera): number | undefined;
  /** cameraReset action */
  reset?(frame: CameraFrame): void;
  /** jump straight to the steady-state pose (after a teleport / flight reset) */
  snap?(frame: CameraFrame, camera: THREE.PerspectiveCamera): void;
  /** the render-frame origin moved: translate world-anchored state by `delta` */
  shiftOrigin?(delta: THREE.Vector3): void;
}
