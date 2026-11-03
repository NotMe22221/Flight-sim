/**
 * Camera module types: tuning options and the per-frame context handed to each mode.
 */
import type * as THREE from 'three';
import type { AircraftState, CameraMode, InputSnapshot, SimAxis } from '../core/types';

/** Which InputSnapshot axes translate the drone camera. */
export interface DroneAxisMap {
  /** axis for forward/back (+ = forward along the view); default 'pitch' */
  forward: SimAxis;
  /** axis for strafe (+ = right); default 'roll' */
  strafe: SimAxis;
  /** axis for vertical; default 'throttle' */
  vertical: SimAxis;
  /** value of `vertical` that means "no vertical motion" (0.5 for a 0..1 throttle, 0 for a ±1 axis) */
  verticalCentre: number;
  /** dead band around the centre */
  verticalDeadband: number;
}

export interface CameraOptions {
  /** overall aircraft length, scales chase distance / auto-FOV (default 8.28) */
  aircraftLengthM?: number;
  /** default field of view, deg (default 70) */
  defaultFovDeg?: number;
  minFovDeg?: number;
  maxFovDeg?: number;
  /** multiplicative step for zoomIn/zoomOut actions (default 0.8) */
  zoomStep?: number;
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
  /** cockpit free-look limits (default ±160°, −60°/+80°) */
  cockpitYawLimitRad?: number;
  cockpitPitchMinRad?: number;
  cockpitPitchMaxRad?: number;
  /** head orientation lags the aircraft attitude with this time constant (default 0.08 s) */
  headLagTauS?: number;
  /** g-induced vertical head offset, m per g of (nz − 1) (default 0.03), clamped to ±gBobMaxM (0.05) */
  gBobMPerG?: number;
  gBobMaxM?: number;
  /** chase distance (default 3 × aircraft length ≈ 25 m), scaled by the cameraZoom axis */
  chaseDistanceM?: number;
  /** chase elevation angle above the aircraft (default 15°) */
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
  /** drone base speed, m/s (default 20), scaled by 8^cameraZoom */
  droneBaseSpeedMs?: number;
  droneAxes?: Partial<DroneAxisMap>;
  /** tower auto-FOV: aircraft length as a fraction of the frame height (default 0.04) */
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
    minFovDeg: o.minFovDeg ?? 15,
    maxFovDeg: o.maxFovDeg ?? 110,
    zoomStep: o.zoomStep ?? 0.8,
    farM: o.farM ?? 600_000,
    nearCockpitM: o.nearCockpitM ?? 0.05,
    nearExternalM: o.nearExternalM ?? 0.5,
    pointerSensitivity: o.pointerSensitivity ?? 0.0025,
    lookRateRadS: o.lookRateRadS ?? 2.0,
    recentreTauS: o.recentreTauS ?? 0.12,
    cockpitYawLimitRad: o.cockpitYawLimitRad ?? 160 * D2R,
    cockpitPitchMinRad: o.cockpitPitchMinRad ?? -60 * D2R,
    cockpitPitchMaxRad: o.cockpitPitchMaxRad ?? 80 * D2R,
    headLagTauS: o.headLagTauS ?? 0.08,
    gBobMPerG: o.gBobMPerG ?? 0.03,
    gBobMaxM: o.gBobMaxM ?? 0.05,
    chaseDistanceM: o.chaseDistanceM ?? 3 * length,
    chaseElevationRad: o.chaseElevationRad ?? 15 * D2R,
    chasePosTauS: o.chasePosTauS ?? 0.35,
    chaseLookTauS: o.chaseLookTauS ?? 0.15,
    chaseRollFollow: o.chaseRollFollow ?? 0.3,
    orbitMinM: o.orbitMinM ?? 8,
    orbitMaxM: o.orbitMaxM ?? 200,
    orbitInertiaTauS: o.orbitInertiaTauS ?? 0.4,
    droneBaseSpeedMs: o.droneBaseSpeedMs ?? 20,
    droneAxes: { forward: 'pitch', strafe: 'roll', vertical: 'throttle', verticalCentre: 0.5, verticalDeadband: 0.08, ...o.droneAxes },
    towerFrameFraction: o.towerFrameFraction ?? 0.04,
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
  /** cameraZoom axis, −1..1 */
  zoomAxis: number;
}

/** Interface implemented by each camera mode. */
export interface CameraModeHandler {
  /** called when the mode becomes active; `camera` holds the previous mode's pose */
  enter(frame: CameraFrame, camera: THREE.PerspectiveCamera): void;
  /** write camera.position / camera.quaternion; return a fov (deg) or undefined for the user FOV */
  update(frame: CameraFrame, camera: THREE.PerspectiveCamera): number | undefined;
  /** cameraReset action */
  reset?(frame: CameraFrame): void;
}
