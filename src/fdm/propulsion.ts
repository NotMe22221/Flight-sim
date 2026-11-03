/**
 * Piston engine + fixed-pitch propeller (docs/research/02 §4).
 *
 * Engine: manifold pressure is a state filled through a throttle orifice (choked at idle, so
 * idle airflow is nearly rpm-independent) and emptied by the cylinders' volumetric flow.
 * Indicated power follows airflow × fuel/air ratio / ISFC × mixture efficiency (JSBSim FGPiston
 * "model B"); friction (Coulomb + viscous) and pumping losses act on the crank. RPM is a state
 * driven by engine, starter and propeller torques on the combined rotating inertia.
 *
 * Propeller: Ct/Cp(J) tables, extrapolated ∝ J² beyond the table so a stopped or slowly
 * windmilling propeller still produces finite drag and torque. Thrust acts at the hub with a
 * P-factor shift of the thrust line; the airframe feels the engine's reaction torque and the
 * rotating assembly's gyroscopic moment.
 */
import { Table1D } from '../core/math';
import type { PistonEngineSpec, PropellerSpec, Vec3 } from '../core/types';
import { INHG } from '../core/units';
import { R_AIR, GAMMA } from './atmosphere';

const TWO_PI = 2 * Math.PI;
const LB_PER_KG = 1 / 0.45359237;
const W_PER_HP = 745.7;
const STOICH = 14.7;
const CHOKED = Math.sqrt(GAMMA) * Math.pow(2 / (GAMMA + 1), (GAMMA + 1) / (2 * (GAMMA - 1))); // 0.6847
const PR_CRIT = Math.pow(2 / (GAMMA + 1), GAMMA / (GAMMA - 1)); // 0.5283
const J_MAX_FALLBACK = 3;

export interface PropulsionControls {
  throttle: number;
  mixture: number;
  magnetos: 0 | 1 | 2 | 3;
  starter: boolean;
  /** starter supply 0..1 (battery terminal voltage while cranking); undefined = full */
  starterFactor?: number;
  fuelAvailable: boolean;
}

export interface PropulsionAir {
  rho: number;
  pAmb: number;
  tAmb: number;
  /** body-axis air-relative velocity at the CG, m/s */
  u: number;
  v: number;
  w: number;
}

export interface PropulsionOutput {
  /** body force at the hub, N */
  F: Float64Array;
  /** body moment about the CG (thrust moment, P-factor, reaction torque), N·m */
  M: Float64Array;
  omegaDot: number;
  mapDot: number;
  thrustN: number;
  /** propeller induced velocity, m/s */
  vi: number;
  /** ½ρ v_i² */
  qbarInduced: number;
  /** ½ρ(u + 2 v_i)² — dynamic pressure of the slipstream at the tail */
  qbarTail: number;
  propTorqueNm: number;
  indicatedTorqueNm: number;
  frictionTorqueNm: number;
  pumpingTorqueNm: number;
  starterTorqueNm: number;
  brakePowerW: number;
  fuelFlowKgS: number;
  fuelAir: number;
  combusting: boolean;
  /** angular momentum of the rotating assembly along body x (signed by rotation sense), kg·m²/s */
  angularMomentum: number;
}

export const newPropulsionOutput = (): PropulsionOutput => ({
  F: new Float64Array(3), M: new Float64Array(3), omegaDot: 0, mapDot: 0, thrustN: 0, vi: 0, qbarInduced: 0, qbarTail: 0,
  propTorqueNm: 0, indicatedTorqueNm: 0, frictionTorqueNm: 0, pumpingTorqueNm: 0, starterTorqueNm: 0, brakePowerW: 0,
  fuelFlowKgS: 0, fuelAir: 0, combusting: false, angularMomentum: 0,
});

/** Flow function of a compressible orifice for pressure ratio pr = p_down/p_up ≤ 1. */
function orificePsi(pr: number): number {
  if (pr <= PR_CRIT) return CHOKED;
  if (pr >= 1) return 0;
  return Math.sqrt(((2 * GAMMA) / (GAMMA - 1)) * (Math.pow(pr, 2 / GAMMA) - Math.pow(pr, (GAMMA + 1) / GAMMA)));
}

export class PistonPropulsion {
  readonly totalInertia: number;
  private readonly ct: Table1D;
  private readonly cp: Table1D;
  private readonly jMax: number;
  private readonly ctEnd: number;
  private readonly cpEnd: number;
  private readonly mixEff: Table1D;
  private readonly diskArea: number;

  constructor(readonly engine: PistonEngineSpec, readonly prop: PropellerSpec) {
    this.totalInertia = engine.inertia + prop.inertia;
    this.ct = new Table1D(prop.Ct.xs, prop.Ct.ys);
    this.cp = new Table1D(prop.Cp.xs, prop.Cp.ys);
    this.jMax = prop.Ct.xs[prop.Ct.xs.length - 1] ?? J_MAX_FALLBACK;
    this.ctEnd = this.ct.at(this.jMax);
    this.cpEnd = this.cp.at(this.jMax);
    this.mixEff = new Table1D(engine.mixtureEfficiency.xs, engine.mixtureEfficiency.ys);
    this.diskArea = (Math.PI * prop.diameterM * prop.diameterM) / 4;
  }

  /**
   * Fuel/air ratio delivered by the mixture lever. Full rich is φ = 1.3 at sea level and the
   * metering enriches with altitude as (p0/p)^0.8 — gentler than JSBSim's (p0/p), matching the
   * venturi-metered servo injector, so an un-leaned engine loses ≈ 5 % at 8 000 ft and ≈ 15 % at
   * 10 000 ft rather than a third of its power.
   */
  fuelAirRatio(mixture: number, pAmb: number): number {
    return (1.3 * mixture * Math.pow(101325 / pAmb, 0.8)) / STOICH;
  }

  /** Mixture-lever position that gives best-power fuel/air (0.083) at this ambient pressure — for an auto-mixture assist. */
  bestPowerMixture(pAmb: number): number {
    const m = (0.083 * STOICH) / (1.3 * Math.pow(101325 / pAmb, 0.8));
    return m > 1 ? 1 : m;
  }

  /** Mixture efficiency for a fuel/air ratio (0 outside the combustible range). */
  mixtureEfficiency(fa: number): number {
    return this.mixEff.at(fa);
  }

  /**
   * Evaluate all propulsion forces and state derivatives.
   * @param omega crank angular speed, rad/s (state)
   * @param mapPa manifold pressure, Pa (state)
   * @param hub hub position relative to the current CG, body axes, m
   */
  evaluate(omega: number, mapPa: number, air: PropulsionAir, c: PropulsionControls, hub: Vec3, out: PropulsionOutput): PropulsionOutput {
    const e = this.engine, pr = this.prop;
    const w = omega > 0 ? omega : 0;
    const rho = air.rho;
    const sense = pr.sense;

    // ── Manifold: throttle orifice in, cylinders out ─────────────────────────
    const uAx = air.u > 0 ? air.u : 0;
    const pIntake = air.pAmb + 0.5 * 0.5 * rho * uAx * uAx; // partial ram recovery
    const th = c.throttle < 0 ? 0 : c.throttle > 1 ? 1 : c.throttle;
    const area = e.throttleAreaIdleM2 + (e.throttleAreaMaxM2 - e.throttleAreaIdleM2) * th * th;
    const rt = R_AIR * air.tAmb;
    const map = mapPa > 1000 ? mapPa : 1000;
    let mdotIn: number;
    if (map <= pIntake) mdotIn = (area * pIntake * orificePsi(map / pIntake)) / Math.sqrt(rt);
    else mdotIn = -(area * map * orificePsi(pIntake / map)) / Math.sqrt(rt);
    const sweptRate = (e.displacementM3 * w) / (4 * Math.PI); // m³/s (one intake per 2 revolutions)
    const mdotAir = (sweptRate * e.VE * map) / rt;
    out.mapDot = (rt / e.manifoldVolumeM3) * (mdotIn - mdotAir);

    // ── Combustion ───────────────────────────────────────────────────────────
    const fa = c.mixture > 0.001 ? this.fuelAirRatio(c.mixture, air.pAmb) : 0;
    const fuelOn = c.fuelAvailable && fa > 0;
    const fuelFlow = fuelOn ? mdotAir * fa : 0;
    const rpm = (w * 60) / TWO_PI;
    const sparks = c.magnetos === 3 ? 1 : c.magnetos === 0 ? 0 : 0.9;
    const etaMix = fuelOn ? this.mixEff.at(fa) : 0;
    const combusting = sparks > 0 && etaMix > 0 && rpm >= e.minFiringRPM;
    const mapInHg = map / INHG;
    const lowLoad = 0.55 + 0.45 * smooth(8, 20, mapInHg);
    const pInd = combusting ? ((fuelFlow * 3600 * LB_PER_KG) / e.ISFC) * W_PER_HP * etaMix * sparks * lowLoad : 0;
    const wEff = w > 1 ? w : 1;
    const qInd = pInd / wEff;

    // ── Losses and starter ───────────────────────────────────────────────────
    const spin = Math.tanh(w / 5);
    const qFric = e.frictionA * spin + e.frictionB * w;
    const dp = air.pAmb - map;
    const qPump = ((dp > 0 ? dp : 0) * e.displacementM3) / (4 * Math.PI) * spin;
    const crankMax = (450 * TWO_PI) / 60;
    const sf = c.starterFactor ?? 1;
    const qStart = c.starter && sf > 0 ? e.starterTorqueNm * sf * Math.max(0, 1 - (w / crankMax) / Math.max(sf, 0.05)) : 0;

    // ── Propeller ────────────────────────────────────────────────────────────
    const D = pr.diameterM;
    const n = w / TWO_PI;
    const nD = n * D;
    let thrust: number, qProp: number;
    if (uAx > this.jMax * nD) {
      // beyond the table (incl. stopped prop): coefficients ∝ J² → forces ∝ V²
      const jm2 = this.jMax * this.jMax;
      thrust = (this.ctEnd / jm2) * rho * uAx * uAx * D * D;
      qProp = (this.cpEnd / (TWO_PI * jm2)) * rho * uAx * uAx * D * D * D;
    } else if (nD > 0) {
      const J = uAx / nD;
      thrust = this.ct.at(J) * rho * n * n * D * D * D * D;
      qProp = (this.cp.at(J) / TWO_PI) * rho * n * n * D * D * D * D * D;
    } else {
      thrust = 0;
      qProp = 0;
    }

    // ── Rotor dynamics ───────────────────────────────────────────────────────
    const qNet = qInd - qFric - qPump + qStart - qProp;
    out.omegaDot = omega <= 0.01 && qNet < 0 ? 0 : qNet / this.totalInertia;

    // ── Slipstream ───────────────────────────────────────────────────────────
    const s = uAx * uAx + (2 * thrust) / (rho * this.diskArea);
    const vi = 0.5 * (-uAx + (s >= 0 ? Math.sqrt(s) : -Math.sqrt(-s)));
    const vTail = uAx + 2 * (vi > 0 ? vi : 0);
    out.vi = vi;
    out.qbarInduced = 0.5 * rho * vi * vi;
    out.qbarTail = 0.5 * rho * vTail * vTail;

    // ── Forces and moments on the airframe ───────────────────────────────────
    // P-factor: the effective thrust line moves toward the side whose blade sees more incidence.
    const vt = Math.sqrt(air.v * air.v + air.w * air.w); // not Math.hypot: its varargs can allocate
    const axial = uAx + (vi > 0 ? vi : 0);
    const f = vt > 1e-6 ? Math.atan2(vt, axial) / vt : axial > 0.1 ? 1 / axial : 0;
    let dy = sense * pr.pFactorM * f * air.w;
    let dz = -sense * pr.pFactorM * f * air.v;
    const dl = Math.sqrt(dy * dy + dz * dz);
    if (dl > 0.5) { dy *= 0.5 / dl; dz *= 0.5 / dl; }
    const ry = hub[1] + dy, rz = hub[2] + dz;
    out.F[0] = thrust; out.F[1] = 0; out.F[2] = 0;
    // r × (T, 0, 0) = (0, r_z T, −r_y T); reaction of the crank torque about x
    const reaction = -sense * (qInd - qFric - qPump + qStart);
    out.M[0] = reaction;
    out.M[1] = rz * thrust;
    out.M[2] = -ry * thrust;

    out.thrustN = thrust;
    out.propTorqueNm = qProp;
    out.indicatedTorqueNm = qInd;
    out.frictionTorqueNm = qFric;
    out.pumpingTorqueNm = qPump;
    out.starterTorqueNm = qStart;
    out.brakePowerW = (qInd - qFric - qPump) * w;
    out.fuelFlowKgS = fuelFlow;
    out.fuelAir = fa;
    out.combusting = combusting;
    out.angularMomentum = sense * this.totalInertia * w;
    return out;
  }

  /**
   * Steady engine state (ω, MAP) for fixed controls and airspeed, by integrating the two engine
   * states alone. Used by trim and by ground spawns with the engine running.
   *
   * Converged tightly (|ω̇| < 1e-4 rad/s², |MAP˙| < 1 Pa/s): trim differentiates the resulting
   * thrust numerically, and a loose tolerance (the rotor time constant is ≈ 1 s, so |ω̇| < 0.05
   * leaves ω off by ≈ 0.05 rad/s) made the trim residual noisy enough to stall Newton at 1e-2.
   */
  equilibrium(air: PropulsionAir, c: PropulsionControls, omega0: number, map0: number, out = { omega: 0, map: 0 }): { omega: number; map: number } {
    const o = newPropulsionOutput();
    const hub: Vec3 = [0, 0, 0];
    let w = omega0, m = map0;
    const dt = 0.005;
    for (let i = 0; i < 40000; i++) {
      this.evaluate(w, m, air, c, hub, o);
      w += o.omegaDot * dt;
      m += o.mapDot * dt;
      if (w < 0) w = 0;
      if (m < 1000) m = 1000;
      if (i > 200 && Math.abs(o.omegaDot) < 1e-4 && Math.abs(o.mapDot) < 1) break;
    }
    out.omega = w;
    out.map = m;
    return out;
  }
}

function smooth(e0: number, e1: number, x: number): number {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}
