/**
 * Interior / exterior listening stage for the engine and environment buses
 * (docs/research/06 §A1.4, §A6).
 *
 * - Cockpit camera: engine low-passed at ~1.2 kHz (cabin attenuation, muffled), environment at
 *   5 kHz (rain patter on the windscreen stays audible), engine ducked while ATC speaks.
 * - Any other camera: brighter (air-absorption low-pass only, 12 kHz·e^(−d/2500 m) beyond 200 m),
 *   inverse-distance attenuation (ref 15 m), stereo pan for the drone camera and a Doppler ratio
 *   from camera-relative velocity (manual Doppler: Web Audio removed PannerNode Doppler).
 *   The cockpit bus (warnings, switches) is attenuated outside.
 *
 * The listener position is estimated from `CameraState` (orbit distance, drone position) unless
 * the app supplies the real camera pose with {@link ViewStage.setListener}.
 */
import { wrapPi } from '../core/math';
import type { AircraftState, CameraMode, CameraState, Vec3 } from '../core/types';
import { airAbsorptionCutoffHz, dopplerRatio, inverseDistanceGain } from './engineMath';
import { mkFilter, mkGain, NodeBag } from './nodes';
import { SmoothParam, TAU, TAU_SLOW } from './params';

/** Stage constants. */
export const VIEW = {
  /** cockpit low-pass of the engine bus, Hz */
  cabinEngineCutoffHz: 1200,
  /** cockpit low-pass of the environment bus, Hz */
  cabinEnvCutoffHz: 5000,
  /** cockpit levels (cabin attenuation ≈ −6 dB on the engine) */
  cabinEngineLevel: 0.5,
  cabinEnvLevel: 0.8,
  /** exterior levels before distance attenuation */
  exteriorEngineLevel: 1,
  exteriorEnvLevel: 0.6,
  /** cockpit bus level in exterior views */
  cockpitBusExterior: 0.35,
  /** engine duck while ATC speaks (−6 dB) */
  duck: 0.5,
  /** inverse-distance model reference distance, m */
  refDistanceM: 15,
  /** assumed camera distances when the app gives no pose, m */
  chaseDistanceM: 25,
  wingDistanceM: 5,
  fixedCameraDistanceM: 150,
} as const;

const isCoMoving = (m: CameraMode): boolean => m === 'chase' || m === 'external-orbit' || m === 'wing' || m === 'cockpit';

/** Owns the view-dependent nodes between the engine/environment buses and the master. */
export class ViewStage {
  private readonly bag = new NodeBag();
  private readonly engineLp: SmoothParam;
  private readonly envLp: SmoothParam;
  private readonly engineLevel: SmoothParam;
  private readonly envLevel: SmoothParam;
  private readonly distance: SmoothParam;
  private readonly pan: SmoothParam;
  private readonly cabin: SmoothParam;
  private readonly lisPos: Vec3 = [0, 0, 0];
  private readonly lisVel: Vec3 = [0, 0, 0];
  private hasListener = false;
  private _exterior = false;
  private _doppler = 1;
  private _distanceM = 0;
  private ducked = false;

  constructor(private readonly ctx: BaseAudioContext, engineBus: AudioNode, envBus: AudioNode, master: AudioNode, cabin: GainNode) {
    const b = this.bag, t = ctx.currentTime;
    const eLp = b.add(mkFilter(ctx, 'lowpass', VIEW.cabinEngineCutoffHz, 0.7));
    const vLp = b.add(mkFilter(ctx, 'lowpass', VIEW.cabinEnvCutoffHz, 0.7));
    const eGain = b.add(mkGain(ctx, VIEW.cabinEngineLevel));
    const vGain = b.add(mkGain(ctx, VIEW.cabinEnvLevel));
    const dist = b.add(mkGain(ctx, 1));
    const panner = b.add(ctx.createStereoPanner());
    engineBus.connect(eLp).connect(eGain).connect(dist);
    envBus.connect(vLp).connect(vGain).connect(dist);
    dist.connect(panner).connect(master);
    this.engineLp = new SmoothParam(eLp.frequency, TAU_SLOW, 1, 0.01);
    this.envLp = new SmoothParam(vLp.frequency, TAU_SLOW, 1, 0.01);
    this.engineLevel = new SmoothParam(eGain.gain, TAU_SLOW);
    this.envLevel = new SmoothParam(vGain.gain, TAU_SLOW);
    this.distance = new SmoothParam(dist.gain, TAU);
    this.pan = new SmoothParam(panner.pan, TAU, 0.005);
    this.cabin = new SmoothParam(cabin.gain, TAU_SLOW);
    this.engineLp.init(VIEW.cabinEngineCutoffHz, t); this.envLp.init(VIEW.cabinEnvCutoffHz, t);
    this.engineLevel.init(VIEW.cabinEngineLevel, t); this.envLevel.init(VIEW.cabinEnvLevel, t);
    this.distance.init(1, t); this.pan.init(0, t); this.cabin.init(1, t);
  }

  /** True when the camera is outside the aircraft. */
  get exterior(): boolean { return this._exterior; }
  /** Doppler pitch ratio for the synths (1 for co-moving cameras). */
  get doppler(): number { return this._doppler; }
  /** Estimated aircraft–listener distance, m. */
  get distanceM(): number { return this._distanceM; }
  /** Engine low-pass cutoff currently targeted, Hz. */
  get engineCutoffHz(): number { return this.engineLp.target; }
  /** Environment low-pass cutoff currently targeted, Hz. */
  get envCutoffHz(): number { return this.envLp.target; }

  /**
   * Supply the real camera pose (local NED, m and m/s); pass null to fall back to estimates
   * from CameraState. Copies the values (no references kept).
   */
  setListener(posNED: Readonly<Vec3> | null, velNED?: Readonly<Vec3>): void {
    if (!posNED) { this.hasListener = false; return; }
    this.lisPos[0] = posNED[0]; this.lisPos[1] = posNED[1]; this.lisPos[2] = posNED[2];
    this.lisVel[0] = velNED ? velNED[0] : 0; this.lisVel[1] = velNED ? velNED[1] : 0; this.lisVel[2] = velNED ? velNED[2] : 0;
    this.hasListener = true;
  }

  /** Duck the engine bus (−6 dB) while ATC speech plays. */
  setDuck(on: boolean): void {
    if (on === this.ducked) return;
    this.ducked = on;
    this.applyLevels(this.ctx.currentTime);
  }

  /** Per-frame update from the aircraft and camera; allocation-free. */
  update(ac: AircraftState, camera: CameraState): void {
    const now = this.ctx.currentTime;
    const mode = camera.mode;
    this._exterior = mode !== 'cockpit';
    let pan = 0;
    if (!this._exterior) {
      this._distanceM = 0;
      this._doppler = 1;
    } else if (mode === 'drone' || (this.hasListener && !isCoMoving(mode))) {
      const lp = this.hasListener ? this.lisPos : camera.dronePosNED;
      const lv = this.hasListener ? this.lisVel : ZERO;
      const p = ac.posNED;
      const dn = p[0] - lp[0], de = p[1] - lp[1], dd = p[2] - lp[2];
      this._distanceM = Math.sqrt(dn * dn + de * de + dd * dd);
      this._doppler = dopplerRatio(p, ac.velNED, lp, lv, ac.atmosphere.speedOfSound);
      if (mode === 'drone') pan = 0.8 * Math.sin(wrapPi(Math.atan2(de, dn) - camera.droneYaw));
    } else {
      this._doppler = 1; // chase / orbit / wing cameras move with the aircraft
      this._distanceM = mode === 'external-orbit' ? Math.max(1, camera.orbitDistanceM)
        : mode === 'wing' ? VIEW.wingDistanceM
          : mode === 'chase' ? VIEW.chaseDistanceM : VIEW.fixedCameraDistanceM;
    }
    if (!Number.isFinite(this._distanceM)) this._distanceM = VIEW.fixedCameraDistanceM;
    if (!Number.isFinite(pan)) pan = 0;
    const absorb = airAbsorptionCutoffHz(this._distanceM);
    this.engineLp.set(this._exterior ? absorb : VIEW.cabinEngineCutoffHz, now);
    this.envLp.set(this._exterior ? absorb : VIEW.cabinEnvCutoffHz, now);
    this.distance.set(this._exterior ? inverseDistanceGain(this._distanceM, VIEW.refDistanceM, 1) : 1, now);
    this.pan.set(pan, now);
    this.applyLevels(now);
  }

  /** Disconnect the stage. */
  dispose(): void { this.bag.dispose(); }

  private applyLevels(now: number): void {
    const duck = this.ducked ? VIEW.duck : 1;
    this.engineLevel.set((this._exterior ? VIEW.exteriorEngineLevel : VIEW.cabinEngineLevel) * duck, now);
    this.envLevel.set(this._exterior ? VIEW.exteriorEnvLevel : VIEW.cabinEnvLevel, now);
    this.cabin.set(this._exterior ? VIEW.cockpitBusExterior : 1, now);
  }
}

const ZERO: Readonly<Vec3> = [0, 0, 0];
