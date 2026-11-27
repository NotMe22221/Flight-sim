/**
 * Turbofan engines (airliner): a spool-lag model of N1 and EGT, thrust from a maximum-thrust table
 * (fraction of the rated static thrust vs Mach × altitude) scaled by an N1 → thrust curve, TSFC fuel
 * flow, and thrust reversers. All engines share one throttle (a single lever, as the keyboard has), so
 * one N1 / EGT state pair drives them all; each engine's thrust line acts at its own position, so the
 * forces and moments are summed about the CG.
 *
 * State slots (the FDM's two engine slots): 13 = N1 (fraction of 100 %), 14 = EGT (K). The derivative
 * output reuses PropulsionOutput's `omegaDot` (dN1/dt) and `mapDot` (dEGT/dt).
 *
 * Running: fuel available and the fuel lever (the mixture control) on. Starting: the starter spools N1
 * toward 18 %, where the engine lights off. A shut-down engine windmills with the airspeed.
 */
import { Table2D, clamp } from '../core/math';
import type { TurbofanEngineSpec, Vec3 } from '../core/types';
import type { PropulsionAir, PropulsionControls, PropulsionOutput } from './propulsion';

/** N1 at which a starting engine lights off. */
const LIGHT_OFF_N1 = 0.18;

/** Thrust fraction of the maximum at an N1 fraction: ≈ 3 % at ground idle (≈ 20 %), 100 % at 100 %. */
export function thrustFractionAtN1(n1: number): number {
  const x = clamp((n1 - 0.1) / 0.9, 0, 1.08);
  return Math.pow(x, 1.6);
}

export class TurbofanPropulsion {
  private readonly maxThrust: Table2D;
  /** combusting (lit) — latched by light-off, cleared by fuel cut */
  lit = false;

  constructor(readonly spec: TurbofanEngineSpec, readonly positions: readonly Vec3[]) {
    this.maxThrust = new Table2D(spec.milThrust.rows, spec.milThrust.cols, spec.milThrust.data);
  }

  get engineCount(): number { return Math.max(1, this.positions.length); }

  /** N1 the engine settles at for these controls (fraction). */
  targetN1(ctl: PropulsionControls, mach: number, reverse: boolean): number {
    const run = ctl.fuelAvailable && ctl.mixture > 0.5;
    if (!run) return clamp(0.04 + 0.2 * mach, 0, 0.3); // windmilling
    const thr = reverse ? 0.75 : clamp(ctl.throttle, 0, 1);
    return this.spec.idleN1 + (1.0 - this.spec.idleN1) * thr;
  }

  /** EGT (K) the engine settles at, for an N1 and the ambient temperature. */
  targetEgt(n1: number, tAmb: number, lit: boolean): number {
    return lit ? tAmb + 300 + 520 * clamp(n1, 0, 1.05) ** 1.5 : tAmb + 20 * n1;
  }

  /**
   * Thrust, moments, fuel flow and the slot derivatives. `cg`: the CG position (body m), for the moment
   * arms of the engine positions. `reverse`: the reversers are deployed (thrust points forward).
   */
  evaluate(n1: number, egt: number, air: PropulsionAir, ctl: PropulsionControls, cg: Vec3, altM: number, mach: number, reverse: boolean, out: PropulsionOutput): PropulsionOutput {
    const run = ctl.fuelAvailable && ctl.mixture > 0.5;
    if (!run) this.lit = false;
    else if (!this.lit && n1 >= LIGHT_OFF_N1) this.lit = true;
    let target = this.targetN1(ctl, mach, reverse);
    if (run && !this.lit) target = ctl.starter ? LIGHT_OFF_N1 + 0.02 : clamp(0.04 + 0.2 * mach, 0, 0.3);
    // slower below 60 % (the core accelerates slowly from idle: idle → take-off thrust in ≈ 6 s)
    const tau = this.spec.spoolTauS * (n1 < 0.6 ? 1.8 : 1) * (target < n1 ? 0.8 : 1);
    out.omegaDot = (target - n1) / Math.max(tau, 0.05);
    out.mapDot = (this.targetEgt(n1, air.tAmb, this.lit) - egt) / 2.5;

    const perEngine = this.lit ? this.spec.ratedThrustN * this.maxThrust.at(mach, altM) * thrustFractionAtN1(n1) : 0;
    const dir = reverse && this.lit ? -this.spec.reverserFraction / 0.75 : 1; // reverse idle-to-75 % N1
    const T = perEngine * dir;
    const F = out.F, M = out.M;
    F[0] = 0; F[1] = 0; F[2] = 0; M[0] = 0; M[1] = 0; M[2] = 0;
    for (const p of this.positions) {
      const rx = p[0] - cg[0], ry = p[1] - cg[1], rz = p[2] - cg[2];
      F[0] += T;
      // r × (T, 0, 0)
      M[1] += rz * T;
      M[2] += -ry * T;
      void rx;
    }
    const n = this.engineCount;
    out.thrustN = T * n;
    out.fuelFlowKgS = this.lit ? this.spec.tsfc * Math.max(Math.abs(perEngine), 0.03 * this.spec.ratedThrustN) * n : 0;
    out.combusting = this.lit;
    out.brakePowerW = 0; out.propTorqueNm = 0; out.indicatedTorqueNm = 0; out.frictionTorqueNm = 0; out.pumpingTorqueNm = 0; out.starterTorqueNm = 0;
    out.fuelAir = 0; out.angularMomentum = 0; out.vi = 0; out.qbarInduced = 0;
    out.qbarTail = 0.5 * air.rho * Math.max(air.u, 0) ** 2;
    return out;
  }

  /** Steady N1 and EGT for these controls (trim, running spawns). */
  equilibrium(air: PropulsionAir, ctl: PropulsionControls, mach: number): { omega: number; map: number } {
    const run = ctl.fuelAvailable && ctl.mixture > 0.5;
    this.lit = run;
    const n1 = this.targetN1(ctl, mach, false);
    return { omega: n1, map: this.targetEgt(n1, air.tAmb, run) };
  }
}
