/**
 * Six-degree-of-freedom flight model implementing the `FlightModel` contract.
 *
 * Continuous state integrated with classic RK4 at a fixed step (forces re-evaluated in every
 * stage): position NED, body velocity, body→NED attitude quaternion, body rates, crank speed
 * and manifold pressure. Discrete/slow quantities are advanced once per step: actuators, wind
 * and turbulence sampling, fuel burn, stall hysteresis, α̇, brake anchors, engine temperatures.
 */
import { clamp, qConj, qFromEuler, qMul, qNormalize, qRotate, eulerFromQ } from '../core/math';
import type { AircraftConfig, AircraftState, ControlInputs, Environment, FlightModel, PistonEngineSpec, Quat, SpawnState, Vec3 } from '../core/types';
import { defaultControlInputs } from '../core/types';
import { DEG, INHG } from '../core/units';
import { LocalFrame } from '../geo/wgs84';
import { MagVarCache } from '../geo/magvar';
import { AeroModel, newAeroOutput, type AeroInput } from './aero';
import { atmosphere, casFromTas, easFromTas, iasFromCas, indicatedAltitude, tasFromCas, P0 } from './atmosphere';
import { GearModel } from './gear';
import { computeMassProperties, type MassProperties } from './massProps';
import { PistonPropulsion, newPropulsionOutput, type PropulsionControls } from './propulsion';
import { createAircraftState } from './state';
import { DrydenTurbulence, Rng } from './turbulence';

const NS = 15; // pos 0-2, vel 3-5, quat 6-9, rates 10-12, crank ω 13, MAP 14
const G = 9.80665;
const EARTH_R = 6371000;
/**
 * Stall-warning angle of attack (the leading-edge reed responds to α): 10.3°, 5–8 kt above the
 * 1 g stall flaps up and ≈ 5 kt with full flaps, as the 172S POH states. 0.235 rad (13.5°) gave
 * only 1–3 kt of warning.
 */
const ALPHA_WARN = 0.18;
const TWO_PI = 2 * Math.PI;
const F2K = (f: number) => ((f - 32) * 5) / 9 + 273.15;
const fin = (x: number, fallback: number): number => (Number.isFinite(x) ? x : fallback);
/** First-order lag toward `cmd` with time constant `tau`, rate-limited to `rate` per second. */
const lagRate = (x: number, cmd: number, tau: number, rate: number, dt: number): number => {
  const d = (cmd - x) * (1 - Math.exp(-dt / tau));
  const lim = rate * dt;
  return x + (d > lim ? lim : d < -lim ? -lim : d);
};
const lag1 = (x: number, target: number, tau: number, dt: number): number => x + (target - x) * (1 - Math.exp(-dt / tau));

export interface TrimResult {
  ok: boolean;
  alphaRad: number;
  elevatorRad: number;
  throttle: number;
  /** ControlInputs.pitchTrim that produces the trimmed elevator with the stick centred */
  pitchTrim: number;
  /** stick input still needed when the trim tab cannot reach the trimmed elevator */
  pitchStick: number;
  residual: number;
}

export interface FdmOptions {
  /** PRNG seed for turbulence */
  seed?: number;
  /** epoch used for magnetic variation (ms) */
  utcMs?: number;
}

export class Fdm implements FlightModel {
  readonly state: AircraftState;
  trimResult: TrimResult | null = null;
  crashReason = '';

  private readonly y = new Float64Array(NS);
  private readonly k1 = new Float64Array(NS);
  private readonly k2 = new Float64Array(NS);
  private readonly k3 = new Float64Array(NS);
  private readonly k4 = new Float64Array(NS);
  private readonly yt = new Float64Array(NS);

  private readonly aero: AeroModel;
  private readonly prop: PistonPropulsion;
  private readonly gear: GearModel;
  private readonly turb: DrydenTurbulence;
  private readonly rng: Rng;
  private readonly engineSpec: PistonEngineSpec;
  private readonly magvar = new MagVarCache();
  private utcMs: number;

  private mp: MassProperties;
  private readonly stationKg: Float64Array;
  private readonly tankKg: Float64Array;
  private fuelAtMassCalc = 0;

  // per-step held values
  private env!: Environment;
  private frame: LocalFrame | null = null;
  private dt = 1 / 120;
  private readonly atm = { temperatureK: 288.15, pressurePa: P0, densityKgM3: 1.225, speedOfSound: 340.29 };
  private readonly windNED: Vec3 = [0, 0, 0];
  private groundUp = 0;
  private hyst = 0;
  private alphaDot = 0;
  private alphaPrev = 0;
  private alphaPrevValid = false;
  private steer = 0;
  private brakeL = 0;
  private brakeR = 0;
  private readonly ctl: PropulsionControls = { throttle: 0, mixture: 1, magnetos: 3, starter: false, fuelAvailable: true };
  private lastInputs: ControlInputs = defaultControlInputs();
  // actuators (rad, flaps deg)
  private de = 0;
  private daL = 0;
  private daR = 0;
  private dr = 0;
  private flapDeg = 0;
  private trimDe = 0;
  // engine temperatures (K) and oil pressure (Pa)
  private egt = 288;
  private cht = 288;
  private oilT = 288;
  private oilP = 0;
  private crashed = false;

  // scratch
  private readonly aeroIn: AeroInput = { alpha: 0, beta: 0, V: 0, rho: 1.225, qbar: 0, qbarUW: 0, qbarTail: 0, qbarInduced: 0, propSense: 1, p: 0, q: 0, r: 0, alphaDot: 0, de: 0, da: 0, dr: 0, flapDeg: 0, hOverB: Infinity, hyst: 0 };
  private readonly aeroOut = newAeroOutput();
  private readonly propOut = newPropulsionOutput();
  private readonly gearOut;
  private readonly qb: Quat = [1, 0, 0, 0];
  private readonly qnb: Quat = [1, 0, 0, 0];
  private readonly vtmp: Vec3 = [0, 0, 0];
  private readonly vtmp2: Vec3 = [0, 0, 0];
  private readonly windB: Vec3 = [0, 0, 0];
  private readonly hub: Vec3 = [0, 0, 0];
  private readonly arp: Vec3 = [0, 0, 0];
  private readonly gravB: Vec3 = [0, 0, 0];
  private readonly down: Vec3 = [0, 0, G];
  /** non-gravitational specific force of the last derivative evaluation (body, N/kg) */
  private readonly specF = new Float64Array(3);
  private readonly vb3: Vec3 = [0, 0, 0];
  private readonly w3: Vec3 = [0, 0, 0];
  /** largest wheel contact z (body, relative to the empty CG): gear height for AGL */
  private readonly wheelZ: number;
  private air = { u: 0, v: 0, w: 0, V: 0, alpha: 0, beta: 0 };
  private readonly gearCtl = { brakeLeft: 0, brakeRight: 0, steerRad: 0 };
  private readonly propAir = { rho: 1.225, pAmb: P0, tAmb: 288.15, u: 0, v: 0, w: 0 };
  /** sanitised copy of the current step's inputs */
  private readonly uSafe: ControlInputs = defaultControlInputs();
  private ailCmdL = 0;
  private ailCmdR = 0;

  constructor(readonly config: AircraftConfig, opts: FdmOptions = {}) {
    const eng = config.propulsion.engine;
    if (eng.type !== 'piston' || !config.propulsion.propeller) throw new Error(`Fdm: unsupported propulsion ${eng.type}`);
    this.engineSpec = eng;
    this.aero = new AeroModel(config);
    this.prop = new PistonPropulsion(eng, config.propulsion.propeller);
    this.gear = new GearModel(config.gear);
    this.gearOut = this.gear.newOutput();
    this.rng = new Rng(opts.seed ?? 0x5eed);
    this.turb = new DrydenTurbulence(this.rng, config.geometry.b);
    this.utcMs = opts.utcMs ?? Date.UTC(2026, 10, 1);
    this.stationKg = Float64Array.from(config.mass.stations.map((s) => s.massKg));
    this.tankKg = Float64Array.from(config.mass.tanks.map((t) => t.contentsKg));
    this.mp = computeMassProperties(config, this.stationKg, this.tankKg);
    this.fuelAtMassCalc = this.totalFuel();
    this.state = createAircraftState(config);
    this.wheelZ = Math.max(...config.gear.filter((g) => g.type === 'wheel').map((g) => g.pos[2]));
    this.y[6] = 1;
    this.y[14] = P0;
  }

  // ─────────────────────────────── public API ───────────────────────────────

  /** Set payload (per station) and fuel (per tank), kg. Takes effect immediately. */
  setLoad(stationKg?: ArrayLike<number>, tankKg?: ArrayLike<number>): void {
    if (stationKg) for (let i = 0; i < this.stationKg.length; i++) this.stationKg[i] = clamp(stationKg[i] ?? 0, 0, this.config.mass.stations[i].maxKg);
    if (tankKg) for (let i = 0; i < this.tankKg.length; i++) this.tankKg[i] = clamp(tankKg[i] ?? 0, 0, this.config.mass.tanks[i].capacityKg);
    this.recomputeMass();
  }

  /** Fill every tank to the given fraction of capacity. */
  setFuelFraction(f: number): void {
    this.setLoad(undefined, this.config.mass.tanks.map((t) => t.capacityKg * clamp(f, 0, 1)));
  }

  /** Altimeter (Kollsman) setting, Pa. */
  setAltimeter(pa: number): void { this.state.qnhSetPa = pa; }

  /** World clock used for magnetic variation. */
  setUtc(ms: number): void { this.utcMs = ms; }

  /** Best-power mixture lever position for the current ambient pressure (auto-mixture assist). */
  bestPowerMixture(): number { return this.prop.bestPowerMixture(this.atm.pressurePa); }

  /** End the flight with a structural failure detected outside the model (stress-damage assist). */
  failStructure(reason: string): void { this.crash(reason); }

  /** Clear a crash so the simulation can continue (e.g. "repair" in the UI); usually followed by reset(). */
  clearCrash(): void { this.crashed = false; this.crashReason = ''; this.state.crashed = false; }

  /**
   * Move every actuator (surfaces, flaps, trim tab) straight to the commanded position, skipping the
   * actuator rate limits. Use after reset() and before trim() for an air spawn, so the trim solves
   * for the configuration the flight starts in rather than a flap motor that has barely moved.
   */
  snapControls(inputs: ControlInputs): void {
    const u = this.sanitizeInputs(inputs);
    this.snapActuators(u);
    this.lastInputs = { ...u, lights: { ...u.lights } };
    this.updateOutputs();
  }

  reset(spawn: SpawnState, env: Environment): void {
    this.env = env;
    const frame = this.frameFor(env);
    const p = frame.geodeticToNED(spawn.geo.lat, spawn.geo.lon, spawn.geo.alt);
    const y = this.y;
    y.fill(0);
    y[0] = p[0]; y[1] = p[1]; y[2] = p[2];
    this.crashed = false;
    this.crashReason = '';
    this.hyst = 0;
    this.alphaDot = 0;
    this.alphaPrevValid = false;
    this.turb.reset();
    this.gear.releaseAnchors();
    this.trimResult = null;
    this.state.t = 0;
    this.recomputeMass();
    this.sampleEnvironment();
    const inputs = defaultControlInputs();
    inputs.magnetos = spawn.engineRunning ? 3 : 0;
    inputs.mixture = spawn.engineRunning ? 1 : 0;
    inputs.parkingBrake = spawn.onGround;
    inputs.throttle = 0;
    this.snapActuators(inputs);
    const air = { rho: this.atm.densityKgM3, pAmb: this.atm.pressurePa, tAmb: this.atm.temperatureK, u: 0, v: 0, w: 0 };
    if (spawn.engineRunning) {
      const c: PropulsionControls = { throttle: 0, mixture: 1, magnetos: 3, starter: false, fuelAvailable: true };
      const eq = this.prop.equilibrium(air, c, 700 * TWO_PI / 60, 0.3 * this.atm.pressurePa);
      y[13] = eq.omega; y[14] = eq.map;
      this.egt = F2K(1100); this.cht = F2K(250); this.oilT = F2K(140); this.oilP = 30 * 6894.76;
    } else {
      y[13] = 0; y[14] = this.atm.pressurePa;
      this.egt = this.cht = this.oilT = this.atm.temperatureK; this.oilP = 0;
    }
    if (spawn.onGround) {
      this.placeOnGround(spawn.headingRad);
      // let the struts settle with the parking brake set, then remove residual motion
      for (let i = 0; i < 360; i++) this.step(this.dt, inputs, env);
      y[3] = y[4] = y[5] = 0; y[10] = y[11] = y[12] = 0;
      this.state.t = 0;
      this.updateOutputs();
    } else {
      const q = qFromEuler(0, 0, spawn.headingRad, this.qb);
      y[6] = q[0]; y[7] = q[1]; y[8] = q[2]; y[9] = q[3];
      const cas = casFromTas(Math.max(spawn.speedMs, 25), this.atm.pressurePa, this.atm.speedOfSound);
      this.trim(cas, spawn.gammaRad ?? 0, env);
    }
  }

  step(dt: number, rawInputs: ControlInputs, env: Environment): void {
    if (!(dt > 0 && dt < Infinity)) return; // a zero, negative or NaN step integrates nothing
    this.env = env;
    this.dt = dt;
    const inputs = this.sanitizeInputs(rawInputs);
    this.lastInputs = inputs;
    if (this.crashed) return;
    this.frameFor(env);
    this.sampleEnvironment();
    this.updateActuators(inputs, dt);
    this.updateTurbulence(dt);

    const y = this.y, k1 = this.k1, k2 = this.k2, k3 = this.k3, k4 = this.k4, yt = this.yt;
    this.deriv(y, k1);
    for (let i = 0; i < NS; i++) yt[i] = y[i] + 0.5 * dt * k1[i];
    this.deriv(yt, k2);
    for (let i = 0; i < NS; i++) yt[i] = y[i] + 0.5 * dt * k2[i];
    this.deriv(yt, k3);
    for (let i = 0; i < NS; i++) yt[i] = y[i] + dt * k3[i];
    this.deriv(yt, k4);
    for (let i = 0; i < NS; i++) y[i] += (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    // renormalise attitude, keep engine states physical
    const qn = Math.sqrt(y[6] * y[6] + y[7] * y[7] + y[8] * y[8] + y[9] * y[9]) || 1; // not Math.hypot: its varargs can allocate
    y[6] /= qn; y[7] /= qn; y[8] /= qn; y[9] /= qn;
    if (y[13] < 0) y[13] = 0;
    if (y[14] < 1000) y[14] = 1000;
    for (let i = 0; i < NS; i++) if (!Number.isFinite(y[i])) { this.crash('numerical instability'); return; }

    // outputs consistent with the new state
    this.deriv(y, k1);
    this.state.t += dt;
    this.postStep(dt, inputs);
    this.updateOutputs();
  }

  trim(targetCasMs: number, gammaRad: number, env: Environment): boolean {
    this.env = env;
    this.frameFor(env);
    this.sampleEnvironment();
    const y = this.y;
    const heading = eulerFromQ([y[6], y[7], y[8], y[9]], this.vtmp)[2];
    const V = tasFromCas(targetCasMs, this.atm.pressurePa, this.atm.speedOfSound);
    const mixture = this.lastInputs.mixture > 0 ? this.lastInputs.mixture : 1;
    const ctl: PropulsionControls = { throttle: 0.6, mixture, magnetos: 3, starter: false, fuelAvailable: this.totalFuel() > 0 };
    this.ctl.mixture = mixture; this.ctl.magnetos = 3; this.ctl.starter = false; this.ctl.fuelAvailable = ctl.fuelAvailable;
    // lateral controls at their rigged neutral (the trim is longitudinal only)
    const rc = this.config.controls;
    this.aileronCommand(rc.aileron.rigNorm ?? 0);
    this.daL = this.ailCmdL; this.daR = this.ailCmdR;
    this.dr = -(rc.rudder.rigNorm ?? 0) * rc.rudder.maxDeg * DEG;
    this.steer = 0; this.brakeL = this.brakeR = 0;
    let omega = 2300 * TWO_PI / 60, map = this.atm.pressurePa * 0.8;
    const x = [0.05, 0, 0.6];
    const res = [0, 0, 0];
    const evalRes = (xx: number[], out: number[]): void => {
      const a = xx[0];
      this.de = xx[1];
      ctl.throttle = clamp(xx[2], 0, 1);
      this.ctl.throttle = ctl.throttle;
      const q = qFromEuler(0, a + gammaRad, heading, this.qb);
      y[6] = q[0]; y[7] = q[1]; y[8] = q[2]; y[9] = q[3];
      // inertial = air-relative + wind (body)
      qConj(q, this.qnb);
      const wb = qRotate(this.qnb, this.windNED, this.windB);
      y[3] = V * Math.cos(a) + wb[0]; y[4] = wb[1]; y[5] = V * Math.sin(a) + wb[2];
      y[10] = y[11] = y[12] = 0;
      const eq = this.prop.equilibrium({ rho: this.atm.densityKgM3, pAmb: this.atm.pressurePa, tAmb: this.atm.temperatureK, u: V * Math.cos(a), v: 0, w: V * Math.sin(a) }, ctl, omega, map);
      omega = eq.omega; map = eq.map;
      y[13] = eq.omega; y[14] = eq.map;
      this.deriv(y, this.k1);
      out[0] = this.k1[3]; out[1] = this.k1[5]; out[2] = this.k1[11] * 10;
    };
    let best = Infinity;
    const steps = [1e-4, 1e-4, 1e-3];
    const J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const rp = [0, 0, 0];
    const maxStep = [0.05, 0.05, 0.2];
    // Active set on the throttle stops: when the Newton step leaves [0, 1] the point is power
    // limited, so hold the throttle at the stop and solve ẇ = q̇ = 0 for (α, δe) alone; u̇ ≠ 0 is
    // then the reported residual. The stop is released again if u̇ shows it is not needed.
    let pinned = -1, releases = 0;
    for (let it = 0; it < 60; it++) {
      evalRes(x, res);
      const nrm = pinned < 0 ? Math.hypot(res[0], res[1], res[2]) : Math.hypot(res[1], res[2]);
      if (nrm < 1e-5) {
        if (pinned < 0) break;
        if (releases < 2 && ((pinned === 1 && res[0] > 0) || (pinned === 0 && res[0] < 0))) { pinned = -1; releases++; continue; }
        break;
      }
      const n = pinned < 0 ? 3 : 2;
      for (let j = 0; j < n; j++) {
        const xp = x.slice();
        // one-sided difference that stays inside the throttle range
        const h = j === 2 && x[2] + steps[2] > 1 ? -steps[2] : steps[j];
        xp[j] += h;
        evalRes(xp, rp);
        for (let i = 0; i < 3; i++) J[i][j] = (rp[i] - res[i]) / h;
      }
      const dx = pinned < 0 ? solve3(J, res) : solve2(J[1][0], J[1][1], J[2][0], J[2][1], res[1], res[2]);
      if (!dx) break;
      let lam = 1;
      for (let j = 0; j < n; j++) lam = Math.min(lam, maxStep[j] / Math.max(Math.abs(dx[j]), 1e-12));
      for (let j = 0; j < n; j++) x[j] -= lam * dx[j];
      x[0] = clamp(x[0], -0.2, 0.3);
      x[1] = clamp(x[1], this.config.controls.elevator.minDeg * DEG, this.config.controls.elevator.maxDeg * DEG);
      if (pinned < 0 && (x[2] > 1 || x[2] < 0)) pinned = x[2] > 1 ? 1 : 0;
      x[2] = pinned >= 0 ? pinned : clamp(x[2], 0, 1);
    }
    evalRes(x, res);
    best = Math.hypot(res[0], res[1], res[2]);
    const ok = pinned < 0 && best < 1e-3 && x[2] > 0 && x[2] < 1;
    const { pitchTrim, stick } = this.trimInputsFor(x[1]);
    this.trimDe = this.trimDeflection(pitchTrim);
    this.trimResult = { ok, alphaRad: x[0], elevatorRad: x[1], throttle: x[2], pitchTrim, pitchStick: stick, residual: best };
    this.alphaPrevValid = false;
    this.alphaDot = 0;
    this.lastInputs = { ...this.lastInputs, throttle: x[2], pitchTrim, pitch: stick, roll: 0, yaw: 0, parkingBrake: false, magnetos: 3, mixture };
    this.updateOutputs();
    return ok;
  }

  rebase(rotation: Quat, translationNED: Vec3): void {
    const y = this.y;
    // Brake anchors first, while the state is still in the old frame: an anchor is a ground point
    // under its wheel, so its old-frame D is the wheel contact's D (not the new-frame CG D — the
    // 30 m+ difference, tilted by d/R, used to drag the anchors ≈ 0.14 m sideways at 20 km).
    const qOld: Quat = [y[6], y[7], y[8], y[9]];
    const cg = this.mp.cg, specs = this.config.gear, dOld = y[2];
    this.gear.rebaseAnchors((i, n, e) => {
      const g = specs[i].pos;
      const d = dOld + qRotate(qOld, [g[0] - cg[0], g[1] - cg[1], g[2] - cg[2]], this.vtmp2)[2];
      const r = qRotate(rotation, [n - translationNED[0], e - translationNED[1], d - translationNED[2]], this.vtmp2);
      return [r[0], r[1]];
    });
    const p: Vec3 = [y[0] - translationNED[0], y[1] - translationNED[1], y[2] - translationNED[2]];
    const np = qRotate(rotation, p, this.vtmp);
    y[0] = np[0]; y[1] = np[1]; y[2] = np[2];
    const q = qMul(rotation, qOld, this.qb);
    qNormalize(q, q);
    y[6] = q[0]; y[7] = q[1]; y[8] = q[2]; y[9] = q[3];
    const tv = this.turb.out.velNED;
    const rv = qRotate(rotation, tv, this.vtmp2);
    tv[0] = rv[0]; tv[1] = rv[1]; tv[2] = rv[2];
    this.frame = null;
    // the caller reads the state right away (render interpolation): publish it in the new frame
    this.updatePoseOutputs();
  }

  serialize(): string {
    return JSON.stringify({
      v: 1, y: Array.from(this.y), t: this.state.t,
      act: [this.de, this.daL, this.daR, this.dr, this.flapDeg, this.trimDe, this.steer, this.brakeL, this.brakeR],
      eng: [this.egt, this.cht, this.oilT, this.oilP],
      hyst: this.hyst, alphaDot: this.alphaDot, alphaPrev: this.alphaPrev, alphaPrevValid: this.alphaPrevValid,
      stations: Array.from(this.stationKg), tanks: Array.from(this.tankKg),
      anchors: { a: Array.from(this.gear.anchored), n: Array.from(this.gear.anchorN), e: Array.from(this.gear.anchorE) },
      turb: Array.from(this.turb.x), turbVel: this.turb.out.velNED.slice(), turbPqr: this.turb.out.pqr.slice(), rng: this.rng.state,
      crashed: this.crashed, crashReason: this.crashReason, qnhSet: this.state.qnhSetPa, utc: this.utcMs,
      // air data of the last evaluation: the next step's turbulence filter runs on this airspeed
      air: [this.air.u, this.air.v, this.air.w, this.air.V, this.air.alpha, this.air.beta],
    });
  }

  deserialize(json: string): void {
    const s = JSON.parse(json) as {
      y: number[]; t: number; act: number[]; eng: number[]; hyst: number; alphaDot: number; alphaPrev: number; alphaPrevValid: boolean;
      stations: number[]; tanks: number[]; anchors: { a: number[]; n: number[]; e: number[] }; turb: number[]; turbVel: number[]; turbPqr: number[]; rng: number;
      crashed: boolean; crashReason: string; qnhSet: number; utc: number; air?: number[];
    };
    this.y.set(s.y);
    this.state.t = s.t;
    [this.de, this.daL, this.daR, this.dr, this.flapDeg, this.trimDe, this.steer, this.brakeL, this.brakeR] = s.act;
    [this.egt, this.cht, this.oilT, this.oilP] = s.eng;
    this.hyst = s.hyst; this.alphaDot = s.alphaDot; this.alphaPrev = s.alphaPrev; this.alphaPrevValid = s.alphaPrevValid;
    this.stationKg.set(s.stations); this.tankKg.set(s.tanks);
    this.gear.anchored.set(s.anchors.a); this.gear.anchorN.set(s.anchors.n); this.gear.anchorE.set(s.anchors.e);
    this.turb.x.set(s.turb);
    for (let i = 0; i < 3; i++) { this.turb.out.velNED[i] = s.turbVel[i]; this.turb.out.pqr[i] = s.turbPqr[i]; }
    this.rng.state = s.rng >>> 0;
    this.crashed = s.crashed; this.crashReason = s.crashReason;
    this.state.qnhSetPa = s.qnhSet; this.utcMs = s.utc;
    this.recomputeMass();
    if (this.env) { this.frameFor(this.env); this.sampleEnvironment(); this.deriv(this.y, this.k1); }
    // restore after the refresh above, which re-derives them from the wind at the restored position
    if (s.air) { const a = this.air; a.u = s.air[0]; a.v = s.air[1]; a.w = s.air[2]; a.V = s.air[3]; a.alpha = s.air[4]; a.beta = s.air[5]; }
    // the next step reads ground speed (nose-wheel steering) and heading (turbulence axes) from the
    // published state, so publish at least the pose even before an environment is known
    if (this.env) this.updateOutputs(); else this.updatePoseOutputs();
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private frameFor(env: Environment): LocalFrame {
    const f = env.frame;
    if (!this.frame || this.frame.lat0 !== f.lat0 || this.frame.lon0 !== f.lon0 || this.frame.alt0 !== f.alt0) this.frame = new LocalFrame(f.lat0, f.lon0, f.alt0);
    return this.frame;
  }

  private totalFuel(): number { let s = 0; for (let i = 0; i < this.tankKg.length; i++) s += this.tankKg[i]; return s; }

  private recomputeMass(): void {
    this.mp = computeMassProperties(this.config, this.stationKg, this.tankKg, this.mp);
    this.fuelAtMassCalc = this.totalFuel();
  }

  /** Geodetic altitude of a NED point (flat-earth + curvature drop). */
  private altitudeOf(n: number, e: number, d: number): number {
    return (this.env?.frame.alt0 ?? 0) - d - (n * n + e * e) / (2 * EARTH_R);
  }

  private sampleEnvironment(): void {
    const y = this.y, env = this.env;
    const h = this.altitudeOf(y[0], y[1], y[2]);
    atmosphere(h, env.deltaTisaK, env.qnhPa, this.atm);
    env.windNED(y[0], y[1], y[2], this.windNED);
    this.groundUp = env.groundHeight(y[0], y[1]);
  }

  /**
   * Copy of the pilot inputs with every non-finite number replaced, so one bad value from an input
   * device or autopilot cannot poison the state vector (and end the flight as "numerical
   * instability"). Stick, pedals, brakes and trims fall back to neutral/held values, engine levers
   * and flaps keep their current setting.
   */
  private sanitizeInputs(u: ControlInputs): ControlInputs {
    const s = this.uSafe;
    s.pitch = fin(u.pitch, 0); s.roll = fin(u.roll, 0); s.yaw = fin(u.yaw, 0);
    s.pitchTrim = fin(u.pitchTrim, this.trimPositionFor(this.trimDe));
    s.rudderTrim = fin(u.rudderTrim, 0); s.aileronTrim = fin(u.aileronTrim, 0);
    s.flapsIndex = fin(u.flapsIndex, this.nearestFlapDetent());
    s.throttle = fin(u.throttle, this.ctl.throttle); s.mixture = fin(u.mixture, this.ctl.mixture);
    s.propeller = fin(u.propeller, 1); s.speedbrake = fin(u.speedbrake, 0);
    s.brakeLeft = fin(u.brakeLeft, 0); s.brakeRight = fin(u.brakeRight, 0);
    s.parkingBrake = u.parkingBrake; s.magnetos = u.magnetos; s.starter = u.starter; s.fuelSelector = u.fuelSelector;
    s.gearDown = u.gearDown; s.lights = u.lights; s.pitotHeat = u.pitotHeat; s.carbHeat = u.carbHeat;
    return s;
  }

  /** Trim-wheel position that produces the given trim deflection (inverse of {@link trimDeflection}). */
  private trimPositionFor(trimDe: number): number {
    const c = this.config.controls;
    const up = c.trim.elevatorFraction[0] * -c.elevator.minDeg * DEG, dn = c.trim.elevatorFraction[1] * c.elevator.maxDeg * DEG;
    return trimDe < 0 ? (up > 0 ? -trimDe / up : 0) : dn > 0 ? -trimDe / dn : 0;
  }

  private nearestFlapDetent(): number {
    const det = this.config.controls.flaps.detentsDeg;
    let best = 0;
    for (let i = 1; i < det.length; i++) if (Math.abs(det[i] - this.flapDeg) < Math.abs(det[best] - this.flapDeg)) best = i;
    return best;
  }

  private snapActuators(u: ControlInputs): void {
    const c = this.config.controls;
    this.de = this.elevatorCommand(u);
    this.aileronCommand(this.rollCommand(u));
    this.daL = this.ailCmdL; this.daR = this.ailCmdR;
    this.dr = -this.yawCommand(u) * c.rudder.maxDeg * DEG;
    this.flapDeg = c.flaps.detentsDeg[clamp(Math.round(u.flapsIndex), 0, c.flaps.detentsDeg.length - 1)];
    this.trimDe = this.trimDeflection(u.pitchTrim);
  }

  private trimDeflection(pitchTrim: number): number {
    const c = this.config.controls;
    const t = clamp(pitchTrim, -1, 1);
    return t > 0 ? -t * c.trim.elevatorFraction[0] * -c.elevator.minDeg * DEG : -t * c.trim.elevatorFraction[1] * c.elevator.maxDeg * DEG;
  }

  /** Inverse of the trim mapping: tab position for a total elevator, plus any stick needed beyond tab authority. */
  private trimInputsFor(deRad: number): { pitchTrim: number; stick: number } {
    const c = this.config.controls;
    const upMax = c.trim.elevatorFraction[0] * -c.elevator.minDeg * DEG; // TE-up authority (positive number)
    const dnMax = c.trim.elevatorFraction[1] * c.elevator.maxDeg * DEG;
    let pitchTrim: number, rest: number;
    if (deRad <= 0) { pitchTrim = Math.min(-deRad / upMax, 1); rest = deRad + pitchTrim * upMax; }
    else { pitchTrim = -Math.min(deRad / dnMax, 1); rest = deRad + pitchTrim * dnMax; }
    const stick = rest < 0 ? -rest / (-c.elevator.minDeg * DEG) : -rest / (c.elevator.maxDeg * DEG);
    return { pitchTrim, stick };
  }

  private elevatorCommand(u: ControlInputs): number {
    const c = this.config.controls.elevator;
    const p = clamp(u.pitch, -1, 1);
    const stick = p > 0 ? p * c.minDeg * DEG : -p * c.maxDeg * DEG; // nose-up = TE up = negative
    return clamp(stick + this.trimDeflection(u.pitchTrim), c.minDeg * DEG, c.maxDeg * DEG);
  }

  /** Roll command at the ailerons: stick + aileron trim + ground rigging, −1..1. */
  private rollCommand(u: ControlInputs): number {
    return u.roll + 0.15 * clamp(u.aileronTrim, -1, 1) + (this.config.controls.aileron.rigNorm ?? 0);
  }

  /** Yaw command at the rudder: pedals + rudder trim + ground rigging, −1..1. */
  private yawCommand(u: ControlInputs): number {
    return clamp(u.yaw + 0.3 * clamp(u.rudderTrim, -1, 1) + (this.config.controls.rudder.rigNorm ?? 0), -1, 1);
  }

  /** Differential aileron deflections for a roll command, into ailCmdL / ailCmdR (rad). */
  private aileronCommand(roll: number): void {
    const c = this.config.controls.aileron;
    const a = clamp(roll, -1, 1);
    this.ailCmdL = (a > 0 ? a * c.downDeg : a * c.upDeg) * DEG;
    this.ailCmdR = (a > 0 ? -a * c.upDeg : -a * c.downDeg) * DEG;
  }

  private updateActuators(u: ControlInputs, dt: number): void {
    const c = this.config.controls;
    this.trimDe = this.trimDeflection(u.pitchTrim);
    this.de = lagRate(this.de, this.elevatorCommand(u), c.elevator.tauS, c.elevator.rateDegPerS * DEG, dt);
    this.aileronCommand(this.rollCommand(u));
    this.daL = lagRate(this.daL, this.ailCmdL, c.aileron.tauS, c.aileron.rateDegPerS * DEG, dt);
    this.daR = lagRate(this.daR, this.ailCmdR, c.aileron.tauS, c.aileron.rateDegPerS * DEG, dt);
    this.dr = lagRate(this.dr, -this.yawCommand(u) * c.rudder.maxDeg * DEG, c.rudder.tauS, c.rudder.rateDegPerS * DEG, dt);
    // flap motor
    const det = c.flaps.detentsDeg;
    const target = det[clamp(Math.round(u.flapsIndex), 0, det.length - 1)];
    const span = det[det.length - 1] - det[0];
    const total = c.flaps.transitS.reduce((s, x) => s + x, 0) || 1;
    const rate = span / total;
    const df = target - this.flapDeg;
    this.flapDeg += Math.abs(df) <= rate * dt ? df : Math.sign(df) * rate * dt;
    // nose-wheel steering from the pedals, softened with ground speed for controllability
    const vn = this.state.velNED;
    const gs = Math.sqrt(vn[0] * vn[0] + vn[1] * vn[1]);
    const soft = clamp(1 - gs / 30, 0.4, 1);
    this.steer = clamp(u.yaw, -1, 1) * c.nosewheelSteerDeg * DEG * soft;
    this.brakeL = u.parkingBrake ? 1 : clamp(u.brakeLeft, 0, 1);
    this.brakeR = u.parkingBrake ? 1 : clamp(u.brakeRight, 0, 1);
    // engine controls
    this.ctl.throttle = clamp(u.throttle, 0, 1);
    this.ctl.mixture = clamp(u.mixture, 0, 1);
    this.ctl.magnetos = u.magnetos;
    this.ctl.starter = u.starter;
    this.ctl.fuelAvailable = this.fuelAvailable(u.fuelSelector);
  }

  private fuelAvailable(sel: ControlInputs['fuelSelector']): boolean {
    if (sel === 'off') return false;
    const tanks = this.config.mass.tanks;
    for (let i = 0; i < tanks.length; i++) {
      if (sel !== 'both' && tanks[i].selector !== sel && tanks[i].selector !== 'center') continue;
      if (this.tankKg[i] > tanks[i].capacityKg - tanks[i].usableKg + 1e-6) return true;
    }
    return false;
  }

  private updateTurbulence(dt: number): void {
    const env = this.env, y = this.y;
    const agl = -y[2] - this.groundUp;
    const wind = this.windNED;
    const wHead = wind[0] * wind[0] + wind[1] * wind[1] > 0.25 ? Math.atan2(wind[1], wind[0]) : this.state.headingTrueRad;
    this.turb.step(dt, agl, Math.max(this.air.V, 10), env.turbulence.w20Kt, env.turbulence.intensity, wHead, this.state.headingTrueRad);
  }

  /** Place the aircraft on the gear at (pos N,E) with the given heading, estimating static compressions. */
  private placeOnGround(heading: number): void {
    const y = this.y;
    const wheels = this.config.gear.filter((g) => g.type === 'wheel');
    const cg = this.mp.cg;
    const W = this.mp.mass * G;
    // static load split between nose and mains from the longitudinal CG position
    const nose = wheels.filter((g) => g.maxSteerDeg > 0);
    const mains = wheels.filter((g) => g.maxSteerDeg === 0);
    let theta = 0;
    let mainsZ = 1.3;
    if (nose.length && mains.length) {
      const xn = nose[0].pos[0] - cg[0], xm = mains[0].pos[0] - cg[0];
      const fNose = (-xm / (xn - xm)) * W;
      const fMain = (W - fNose) / mains.length;
      const dn = fNose / nose.length / nose[0].k, dm = fMain / mains[0].k;
      const zn = nose[0].pos[2] - cg[2] - dn, zm = mains[0].pos[2] - cg[2] - dm;
      theta = Math.atan2(zn - zm, xn - xm);
      mainsZ = -xm * Math.sin(theta) + zm * Math.cos(theta);
    }
    const q = qFromEuler(0, theta, heading, this.qb);
    y[6] = q[0]; y[7] = q[1]; y[8] = q[2]; y[9] = q[3];
    const g = this.env.groundHeight(y[0], y[1]);
    y[2] = -g - mainsZ;
    y[3] = y[4] = y[5] = 0;
    y[10] = y[11] = y[12] = 0;
  }

  /** State derivative. Also leaves aero/propulsion/gear outputs for the evaluated state. */
  private deriv(s: Float64Array, out: Float64Array): void {
    const mp = this.mp, cg = mp.cg, cfg = this.config;
    const q = this.qb;
    q[0] = s[6]; q[1] = s[7]; q[2] = s[8]; q[3] = s[9];
    const qnb = qConj(q, this.qnb);
    const p = s[10], qq = s[11], r = s[12];
    const rho = this.atm.densityKgM3;

    // air-relative velocity
    const tv = this.turb.out.velNED;
    this.vtmp[0] = this.windNED[0] + tv[0]; this.vtmp[1] = this.windNED[1] + tv[1]; this.vtmp[2] = this.windNED[2] + tv[2];
    const wb = qRotate(qnb, this.vtmp, this.windB);
    const ua = s[3] - wb[0], va = s[4] - wb[1], wa = s[5] - wb[2];
    const V = Math.sqrt(ua * ua + va * va + wa * wa);
    const alpha = Math.atan2(wa, ua);
    const beta = V > 0.1 ? Math.asin(clamp(va / V, -1, 1)) : 0;
    this.air.u = ua; this.air.v = va; this.air.w = wa; this.air.V = V; this.air.alpha = alpha; this.air.beta = beta;
    const qbar = 0.5 * rho * V * V;

    // propulsion
    const pr = cfg.propulsion.propeller!;
    this.hub[0] = pr.position[0] - cg[0]; this.hub[1] = pr.position[1] - cg[1]; this.hub[2] = pr.position[2] - cg[2];
    const pa = this.propAir;
    pa.rho = rho; pa.pAmb = this.atm.pressurePa; pa.tAmb = this.atm.temperatureK; pa.u = ua; pa.v = va; pa.w = wa;
    const po = this.prop.evaluate(s[13], s[14], pa, this.ctl, this.hub, this.propOut);

    // aerodynamics
    const arp = this.arp;
    arp[0] = cfg.geometry.arpOffset[0] - cg[0]; arp[1] = cfg.geometry.arpOffset[1] - cg[1]; arp[2] = cfg.geometry.arpOffset[2] - cg[2];
    const arpW = qRotate(q, arp, this.vtmp2);
    const hArp = -s[2] - arpW[2] - this.groundUp;
    const ai = this.aeroIn;
    ai.alpha = alpha; ai.beta = beta; ai.V = V; ai.rho = rho; ai.qbar = qbar;
    ai.qbarUW = 0.5 * rho * (ua * ua + wa * wa);
    ai.qbarTail = Math.max(po.qbarTail, 0.5 * rho * Math.max(ua, 0) ** 2);
    ai.qbarInduced = po.qbarInduced;
    ai.propSense = pr.sense;
    const tp = this.turb.out.pqr;
    ai.p = p - tp[0]; ai.q = qq - tp[1]; ai.r = r - tp[2];
    ai.alphaDot = this.alphaDot;
    ai.de = this.de; ai.da = (this.daL - this.daR) / 2; ai.dr = this.dr; ai.flapDeg = this.flapDeg;
    ai.hOverB = hArp > 0 ? hArp / cfg.geometry.b : 0;
    ai.hyst = this.hyst;
    const ao = this.aero.compute(ai, this.aeroOut);

    // ground
    this.vb3[0] = s[3]; this.vb3[1] = s[4]; this.vb3[2] = s[5];
    this.w3[0] = p; this.w3[1] = qq; this.w3[2] = r;
    this.gearCtl.brakeLeft = this.brakeL; this.gearCtl.brakeRight = this.brakeR; this.gearCtl.steerRad = this.steer;
    const go = this.gear.evaluate(s, q, this.vb3, this.w3, cg, mp.mass, this.env, this.gearCtl, this.dt, this.gearOut);

    // totals (body)
    const Fx = ao.F[0] + po.F[0] + go.F[0];
    const Fy = ao.F[1] + po.F[1] + go.F[1];
    const Fz = ao.F[2] + po.F[2] + go.F[2];
    let Mx = ao.M[0] + (arp[1] * ao.F[2] - arp[2] * ao.F[1]) + po.M[0] + go.M[0];
    let My = ao.M[1] + (arp[2] * ao.F[0] - arp[0] * ao.F[2]) + po.M[1] + go.M[1];
    let Mz = ao.M[2] + (arp[0] * ao.F[1] - arp[1] * ao.F[0]) + po.M[2] + go.M[2];
    const m = mp.mass;
    this.specF[0] = Fx / m; this.specF[1] = Fy / m; this.specF[2] = Fz / m;

    const g = qRotate(qnb, this.down, this.gravB);
    const u = s[3], v = s[4], w = s[5];
    out[3] = Fx / m + g[0] - (qq * w - r * v);
    out[4] = Fy / m + g[1] - (r * u - p * w);
    out[5] = Fz / m + g[2] - (p * v - qq * u);

    // rotational dynamics: ω̇ = I⁻¹ (M − ω × (Iω + H))
    const h = po.angularMomentum;
    const Lx = mp.Ixx * p - mp.Ixz * r + h, Ly = mp.Iyy * qq, Lz = mp.Izz * r - mp.Ixz * p;
    Mx -= qq * Lz - r * Ly;
    My -= r * Lx - p * Lz;
    Mz -= p * Ly - qq * Lx;
    const inv = mp.inv;
    out[10] = inv[0] * Mx + inv[2] * Mz;
    out[11] = inv[4] * My;
    out[12] = inv[6] * Mx + inv[8] * Mz;

    // attitude kinematics q̇ = ½ q ⊗ (0, p, q, r)
    out[6] = -0.5 * (p * q[1] + qq * q[2] + r * q[3]);
    out[7] = 0.5 * (p * q[0] + r * q[2] - qq * q[3]);
    out[8] = 0.5 * (qq * q[0] - r * q[1] + p * q[3]);
    out[9] = 0.5 * (r * q[0] + qq * q[1] - p * q[2]);

    // position
    this.vtmp[0] = u; this.vtmp[1] = v; this.vtmp[2] = w;
    const vn = qRotate(q, this.vtmp, this.vtmp2);
    out[0] = vn[0]; out[1] = vn[1]; out[2] = vn[2];

    out[13] = po.omegaDot;
    out[14] = po.mapDot;
  }

  private postStep(dt: number, u: ControlInputs): void {
    const y = this.y;
    // α̇ (filtered finite difference) and stall hysteresis, once per step
    const a = this.air.alpha;
    if (this.alphaPrevValid && this.air.V > 5) {
      const raw = clamp((a - this.alphaPrev) / dt, -5, 5);
      this.alphaDot += (raw - this.alphaDot) * (1 - Math.exp(-dt / 0.05));
    } else this.alphaDot = 0;
    this.alphaPrev = a;
    this.alphaPrevValid = true;
    this.hyst = this.air.V > 5 ? this.aero.updateHysteresis(a, this.hyst) : 0;

    // fuel burn
    const flow = this.propOut.fuelFlowKgS;
    if (flow > 0) this.burnFuel(flow * dt, u.fuelSelector);
    this.recomputeMass();

    this.gear.updateAnchors(this.gearOut, this.gearCtl);

    // engine temperatures and oil pressure (first-order lags toward targets)
    const amb = this.atm.temperatureK;
    const po = this.propOut;
    const run = po.combusting;
    const pct = clamp(po.brakePowerW / this.engineSpec.ratedPowerW, 0, 1.2);
    const fa = po.fuelAir;
    const egtF = run ? 1000 + 500 * clamp(1 - Math.abs(fa - 0.068) / 0.02, 0, 1) * (0.6 + 0.4 * pct) + 250 * pct : 0;
    const egtT = run ? F2K(egtF) : amb;
    const chtT = run ? amb + (F2K(380) - amb) * (0.35 + 0.65 * pct) : amb;
    const oilTT = run ? amb + (F2K(190) - amb) * (0.5 + 0.5 * pct) : amb;
    const rpm = (y[13] * 60) / TWO_PI;
    const oilPT = rpm > 300 ? (25 + 55 * clamp((rpm - 600) / 1800, 0, 1)) * 6894.76 : (rpm / 300) * 15 * 6894.76;
    this.egt = lag1(this.egt, egtT, 3, dt);
    this.cht = lag1(this.cht, chtT, 60, dt);
    this.oilT = lag1(this.oilT, oilTT, 120, dt);
    this.oilP = lag1(this.oilP, oilPT, 0.5, dt);

    // crash conditions
    if (this.gearOut.crash) this.crash(this.gearOut.crash);
    else if (this.env.surface === 'water' && this.gearOut.wheelsOnGround > 0) this.crash('water landing');
  }

  private burnFuel(kg: number, sel: ControlInputs['fuelSelector']): void {
    const tanks = this.config.mass.tanks;
    let n = 0;
    for (let i = 0; i < tanks.length; i++) if (this.tankFeeds(i, sel)) n++;
    if (!n) return;
    const share = kg / n;
    for (let i = 0; i < tanks.length; i++) {
      // decide from the pre-burn contents of this tank only, as the share was computed
      const unusable = tanks[i].capacityKg - tanks[i].usableKg;
      if (this.tankFeeds(i, sel)) this.tankKg[i] = Math.max(unusable, this.tankKg[i] - share);
    }
  }

  private tankFeeds(i: number, sel: ControlInputs['fuelSelector']): boolean {
    const t = this.config.mass.tanks[i];
    return (sel === 'both' || t.selector === sel || t.selector === 'center') && this.tankKg[i] > t.capacityKg - t.usableKg;
  }

  private crash(reason: string): void {
    this.crashed = true;
    this.crashReason = reason;
    this.state.crashed = true;
  }

  /**
   * State outputs that follow from the state vector alone (no local frame needed): position and
   * velocities in the current NED frame, attitude, rates, headings, track. The magnetic heading
   * uses the last published geodetic position.
   */
  private updatePoseOutputs(): void {
    const st = this.state, y = this.y;
    st.posNED[0] = y[0]; st.posNED[1] = y[1]; st.posNED[2] = y[2];
    st.velBody[0] = y[3]; st.velBody[1] = y[4]; st.velBody[2] = y[5];
    const q = this.qb;
    q[0] = y[6]; q[1] = y[7]; q[2] = y[8]; q[3] = y[9];
    this.vtmp[0] = y[3]; this.vtmp[1] = y[4]; this.vtmp[2] = y[5];
    qRotate(q, this.vtmp, st.velNED);
    qConj(q, st.qNB);
    eulerFromQ(q, st.euler);
    st.rates[0] = y[10]; st.rates[1] = y[11]; st.rates[2] = y[12];
    const hdg = st.euler[2] < 0 ? st.euler[2] + TWO_PI : st.euler[2];
    st.headingTrueRad = hdg;
    const dec = this.magvar.get(st.geo.lat, st.geo.lon, st.geo.alt, this.utcMs) * DEG;
    let mh = hdg - dec;
    if (mh < 0) mh += TWO_PI; else if (mh >= TWO_PI) mh -= TWO_PI;
    st.headingMagRad = mh;
    st.groundSpeedMs = Math.sqrt(st.velNED[0] * st.velNED[0] + st.velNED[1] * st.velNED[1]);
    let trk = st.groundSpeedMs > 0.5 ? Math.atan2(st.velNED[1], st.velNED[0]) : hdg;
    if (trk < 0) trk += TWO_PI;
    st.trackRad = trk;
    st.verticalSpeedMs = -st.velNED[2];
  }

  private updateOutputs(): void {
    const st = this.state, y = this.y, cfg = this.config;
    const frame = this.frame!;
    frame.nedToGeodetic(y[0], y[1], y[2], st.geo);
    this.updatePoseOutputs();
    st.loadFactor[0] = this.specF[0] / G; st.loadFactor[1] = this.specF[1] / G; st.loadFactor[2] = -this.specF[2] / G;
    st.altitudeMslM = st.geo.alt;
    const gearH = this.wheelZ - this.mp.cg[2];
    st.altitudeAglM = Math.max(0, -y[2] - this.groundUp - gearH);
    st.atmosphere.temperatureK = this.atm.temperatureK;
    st.atmosphere.pressurePa = this.atm.pressurePa;
    st.atmosphere.densityKgM3 = this.atm.densityKgM3;
    st.atmosphere.speedOfSound = this.atm.speedOfSound;
    st.altitudeIndicatedM = indicatedAltitude(this.atm.pressurePa, st.qnhSetPa);
    st.onGround = this.gearOut.wheelsOnGround > 0;
    st.crashed = this.crashed;

    // air data
    const ae = st.aero, air = this.air;
    ae.alpha = air.alpha; ae.beta = air.beta; ae.alphaDot = this.alphaDot;
    ae.tas = air.V;
    ae.cas = casFromTas(air.u > 0 ? Math.sqrt(air.u * air.u + air.w * air.w) : 0, this.atm.pressurePa, this.atm.speedOfSound);
    ae.eas = easFromTas(air.V, this.atm.densityKgM3);
    ae.ias = iasFromCas(ae.cas, this.flapDeg);
    ae.mach = air.V / this.atm.speedOfSound;
    ae.qbar = 0.5 * this.atm.densityKgM3 * air.V * air.V;
    const ao = this.aeroOut;
    ae.coefficients.CL = ao.CL; ae.coefficients.CD = ao.CD; ae.coefficients.CY = ao.CY;
    ae.coefficients.Cl = ao.Cl; ae.coefficients.Cm = ao.Cm; ae.coefficients.Cn = ao.Cn;
    ae.stalled = this.hyst === 1 || air.alpha > 0.29;
    ae.stallWarning = !st.onGround && air.V > 10 && (air.alpha > ALPHA_WARN || this.hyst === 1);

    // engine
    const po = this.propOut, en = st.engine;
    en.running = po.combusting;
    en.rpm = (y[13] * 60) / TWO_PI;
    en.manifoldPressureInHg = y[14] / INHG;
    en.fuelFlowKgS = po.fuelFlowKgS;
    en.egtK = this.egt; en.chtK = this.cht; en.oilTempK = this.oilT; en.oilPressurePa = this.oilP;
    en.powerW = Math.max(0, po.brakePowerW);
    en.thrustN = po.thrustN;
    en.torqueNm = po.propTorqueNm;
    en.pctPower = en.powerW / this.engineSpec.ratedPowerW;

    // surfaces
    const sf = st.surfaces;
    sf.elevatorRad = this.de; sf.aileronLeftRad = this.daL; sf.aileronRightRad = this.daR; sf.rudderRad = this.dr;
    sf.flapDeg = this.flapDeg; sf.trimRad = this.trimDe; sf.speedbrake = 0;

    // gear (wheels only)
    const go = this.gearOut, wi = this.gear.wheelIndices;
    for (let k = 0; k < wi.length; k++) {
      const i = wi[k], gs = st.gear[k];
      gs.compressionM = go.compression[i];
      gs.normalForceN = go.normalForce[i];
      gs.onGround = go.inContact[i] === 1;
      gs.wheelSpeedMs = go.rollSpeed[i];
      gs.steerRad = cfg.gear[i].maxSteerDeg > 0 ? this.steer : 0;
    }
    for (let i = 0; i < this.tankKg.length; i++) st.fuelKg[i] = this.tankKg[i];
    st.totalMassKg = this.mp.mass;
    st.cgM[0] = this.mp.cg[0]; st.cgM[1] = this.mp.cg[1]; st.cgM[2] = this.mp.cg[2];
    const tv = this.turb.out.velNED;
    st.windNED[0] = this.windNED[0] + tv[0]; st.windNED[1] = this.windNED[1] + tv[1]; st.windNED[2] = this.windNED[2] + tv[2];

    // warnings
    const L = cfg.limits, kt = ae.ias / 0.514444;
    const wn = st.warnings;
    wn.stall = ae.stallWarning;
    wn.overspeed = kt > L.VneKt;
    wn.overG = st.loadFactor[2] > L.nzMax || st.loadFactor[2] < L.nzMin;
    wn.gearOverspeed = false;
    const det = cfg.controls.flaps.detentsDeg;
    let vfe = Infinity;
    for (let i = 1; i < det.length; i++) if (this.flapDeg > det[i - 1] + 0.5) vfe = L.VfeKt[i - 1] ?? vfe;
    wn.flapOverspeed = this.flapDeg > 0.5 && kt > vfe;
    const tanks = cfg.mass.tanks;
    let low = false;
    for (let i = 0; i < tanks.length; i++) if (this.tankKg[i] - (tanks[i].capacityKg - tanks[i].usableKg) < 5 * 2.725) low = true;
    wn.lowFuel = low;
  }
}

/** Solve the 2×2 system [[a, b], [c, d]]·x = [e, f]; returns [x0, x1, 0] or null if singular. */
function solve2(a: number, b: number, c: number, d: number, e: number, f: number): number[] | null {
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  return [(e * d - b * f) / det, (a * f - e * c) / det, 0];
}

/** Solve a 3×3 linear system J x = b by Cramer's rule; null if singular. */
function solve3(J: number[][], b: number[]): number[] | null {
  const [a, bb, c] = J[0], [d, e, f] = J[1], [g, h, i] = J[2];
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const x0 = (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det;
  const x1 = (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det;
  const x2 = (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det;
  return [x0, x1, x2];
}
