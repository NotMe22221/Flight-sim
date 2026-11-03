/**
 * Aerodynamic forces and moments (docs/research/02 §1.7, §2–3).
 *
 * Coefficient build-up follows JSBSim's c172p: table lift and drag in α with a stall-hysteresis
 * branch, flap increments, ground effect on the wing terms, rate and control derivatives, the
 * α̇ terms weighted by q̄ of the u–w plane, and elevator/rudder effectiveness from the propeller
 * slipstream. Beyond the tables the coefficients blend into a flat-plate model so the result is
 * finite and continuous for any α, β and airspeed (spins, tail-slides, flying backwards).
 *
 * Forces are returned in body axes; moments are about the aerodynamic reference point (ARP).
 * The caller transfers them to the current CG.
 */
import { Table1D, smoothstep } from '../core/math';
import type { AircraftConfig } from '../core/types';
import { Grid2D } from './grid';

export interface AeroInput {
  /** angle of attack and sideslip, rad */
  alpha: number;
  beta: number;
  /** true airspeed, m/s */
  V: number;
  rho: number;
  /** ½ρV² */
  qbar: number;
  /** ½ρ(u² + w²) — weights the α̇ terms (JSBSim issue #89) */
  qbarUW: number;
  /** dynamic pressure at the tail including slipstream */
  qbarTail: number;
  /** ½ρ v_i² of the propeller wake, for spiralling-slipstream yaw */
  qbarInduced: number;
  /** propeller rotation sense (+1 clockwise seen from behind), 0 when no propeller */
  propSense: number;
  /** body rates relative to the air mass, rad/s */
  p: number;
  q: number;
  r: number;
  /** rad/s */
  alphaDot: number;
  /** elevator (TE down +), effective aileron (roll right +), rudder (TE left +), rad */
  de: number;
  da: number;
  dr: number;
  flapDeg: number;
  /** height of the ARP above ground divided by span; Infinity when far from ground */
  hOverB: number;
  /** stall hysteresis branch: 0 normal, 1 post-stall */
  hyst: number;
}

export interface AeroOutput {
  /** body forces, N */
  F: Float64Array;
  /** body moments about the ARP, N·m */
  M: Float64Array;
  CL: number;
  CD: number;
  CY: number;
  Cl: number;
  Cm: number;
  Cn: number;
  /** blend weight toward the flat-plate model, 0..1 */
  blend: number;
}

export const newAeroOutput = (): AeroOutput => ({ F: new Float64Array(3), M: new Float64Array(3), CL: 0, CD: 0, CY: 0, Cl: 0, Cm: 0, Cn: 0, blend: 0 });

const V_MIN = 1;

export class AeroModel {
  private readonly S: number;
  private readonly b: number;
  private readonly c: number;
  private readonly cfg: AircraftConfig['aero'];
  private readonly clTable: Grid2D;
  private readonly cdTable: Grid2D;
  private readonly clFlap: Table1D;
  private readonly cdFlap: Table1D;
  private readonly cmFlap: Table1D;
  private readonly cmAlphaScale: Table1D;
  private readonly cmDeScale: Table1D;
  private readonly kCL: Table1D;
  private readonly kCD: Table1D;
  private readonly alphaMin: number;
  private readonly alphaMax: number;
  private readonly maxFlap: number;
  /** high-α fades (FlightGear c172p shapes, softened) */
  private readonly clBetaGain = new Table1D([0.279, 0.297], [1, 2.5]);
  private readonly clDaScale = new Table1D([0.279, 0.297, 0.611], [1, 0.5, 0]);
  private readonly clpScale = new Table1D([0.28, 0.4], [1, 0.4]);
  private readonly cnrScale = new Table1D([0.3, 0.6], [1, 0.5]);

  constructor(config: AircraftConfig) {
    const g = config.geometry;
    this.S = g.S;
    this.b = g.b;
    this.c = g.cbar;
    const a = (this.cfg = config.aero);
    this.clTable = new Grid2D(a.CL.table.rows, a.CL.table.cols, a.CL.table.data);
    this.cdTable = new Grid2D(a.CD.alphaFlapTable.rows, a.CD.alphaFlapTable.cols, a.CD.alphaFlapTable.data);
    this.clFlap = new Table1D(a.CL.dFlap.xs, a.CL.dFlap.ys);
    this.cdFlap = new Table1D(a.CD.dFlap.xs, a.CD.dFlap.ys);
    this.cmFlap = new Table1D(a.Cm.dFlap.xs, a.Cm.dFlap.ys);
    this.cmAlphaScale = new Table1D(a.Cm.highAlphaScale.xs, a.Cm.highAlphaScale.ys);
    this.cmDeScale = new Table1D(a.Cm.deHighAlphaScale.xs, a.Cm.deHighAlphaScale.ys);
    this.kCL = new Table1D(a.groundEffect.hOverB, a.groundEffect.kCL);
    this.kCD = new Table1D(a.groundEffect.hOverB, a.groundEffect.kCD);
    this.alphaMin = a.CL.table.rows[0];
    this.alphaMax = a.blendStartRad;
    const fl = a.CL.dFlap.xs;
    this.maxFlap = fl[fl.length - 1] || 1;
  }

  /** Stall-hysteresis branch update (call once per step, not per RK stage). */
  updateHysteresis(alpha: number, current: number): number {
    if (current === 0 && alpha > this.cfg.CL.hystOnRad) return 1;
    if (current === 1 && alpha < this.cfg.CL.hystOffRad) return 0;
    return current;
  }

  compute(i: AeroInput, out: AeroOutput): AeroOutput {
    const a = this.cfg;
    const { alpha, beta } = i;
    const V = i.V < V_MIN ? V_MIN : i.V;
    const absA = Math.abs(alpha);
    const ac = alpha < this.alphaMin ? this.alphaMin : alpha > this.alphaMax ? this.alphaMax : alpha;
    const w = smoothstep(a.blendStartRad, a.blendEndRad, absA);
    const flap = i.flapDeg;
    const flapFrac = flap <= 0 ? 0 : flap >= this.maxFlap ? 1 : flap / this.maxFlap;
    const hb = i.hOverB;
    const kCL = hb >= 1.1 ? 1 : this.kCL.at(hb < 0 ? 0 : hb);
    const kCD = hb >= 1.1 ? 1 : this.kCD.at(hb < 0 ? 0 : hb);
    const sinA = Math.sin(alpha), cosA = Math.cos(alpha);
    const sinB = Math.sin(beta), cosB = Math.cos(beta);

    const ph = (i.p * this.b) / (2 * V);
    const qh = (i.q * this.c) / (2 * V);
    const rh = (i.r * this.b) / (2 * V);
    const adh = (i.alphaDot * this.c) / (2 * V);
    const qbar = i.qbar > 1e-9 ? i.qbar : 1e-9;
    const uwRatio = i.qbarUW / qbar;
    const tailRatio = i.qbarTail / qbar;

    // ── Lift ────────────────────────────────────────────────────────────────
    const flapFade = cosA * cosA * (1 - smoothstep(0.6, 0.785, absA));
    const clWing = kCL * (this.clTable.at(ac, i.hyst) + this.clFlap.at(flap) * flapFade);
    const cn90 = a.CL.CD90;
    const clFlat = cn90 * sinA * cosA;
    const deScale = this.cmDeScale.at(absA);
    const CL = (1 - w) * clWing + w * clFlat + a.CL.dElev * i.de * deScale + a.CL.q * qh + a.CL.adot * adh * uwRatio;

    // ── Drag ────────────────────────────────────────────────────────────────
    const cdTab = a.CD.CD0 + kCD * (this.cdTable.at(ac, flap) + this.cdFlap.at(flap));
    const cdFlat = a.CD.CD0 + cn90 * sinA * sinA;
    const CD = (1 - w) * cdTab + w * cdFlat + a.CD.dElevAbs * Math.abs(i.de) + a.CD.betaAbs * Math.abs(sinB);

    // ── Side force ──────────────────────────────────────────────────────────
    // JSBSim tabulates these lateral terms at α = 0 and 0.094 rad only and clamps outside
    const acl = ac < -0.05 ? -0.05 : ac > 0.094 ? 0.094 : ac;
    const cyBeta = a.CY.beta * (1 - 0.226 * flapFrac); // −0.393 → −0.304 at full flap
    const cyP = a.CY.p - 0.745 * acl - 0.086 * flapFrac;
    const cyR = a.CY.r + 0.564 * acl - 0.052 * flapFrac;
    const CY = cyBeta * sinB + cyP * ph + cyR * rh + a.CY.da * i.da + a.CY.dr * i.dr;

    // ── Roll ────────────────────────────────────────────────────────────────
    const clR = a.Cl.r + 1.14 * acl + 0.0448 * flapFrac;
    const Cl = a.Cl.beta * sinB * this.clBetaGain.at(absA) + a.Cl.p * ph * this.clpScale.at(absA) + clR * rh + a.Cl.da * i.da * this.clDaScale.at(absA) + a.Cl.dr * i.dr * tailRatio;

    // ── Pitch ───────────────────────────────────────────────────────────────
    const cmStatic = a.Cm.Cm0 + a.Cm.alpha * ac * this.cmAlphaScale.at(absA) + this.cmFlap.at(flap);
    const cmFlat = -0.25 * cn90 * sinA * (cosA >= 0 ? 1 : -1);
    const Cm = (1 - w) * cmStatic + w * cmFlat + a.Cm.q * qh + a.Cm.adot * adh * uwRatio + a.Cm.de * i.de * deScale * (a.controlsUseSlipstreamQ.elevator ? tailRatio : 1);

    // ── Yaw ─────────────────────────────────────────────────────────────────
    const cnDa = a.Cn.da - 0.6 * acl;
    let Cn = a.Cn.beta * sinB + a.Cn.p * ph + a.Cn.r * rh * this.cnrScale.at(absA) + cnDa * i.da + a.Cn.dr * i.dr * (a.controlsUseSlipstreamQ.rudder ? tailRatio : 1);
    // Spiralling slipstream striking the fin (nose-left for a clockwise propeller)
    Cn += (a.Cn.slipstream * i.propSense * i.qbarInduced) / qbar;

    // ── Wind axes → body axes ───────────────────────────────────────────────
    const qS = qbar * this.S;
    const L = qS * CL, D = qS * CD, Y = qS * CY;
    const F = out.F, M = out.M;
    F[0] = -D * cosA * cosB - Y * cosA * sinB + L * sinA;
    F[1] = -D * sinB + Y * cosB;
    F[2] = -D * sinA * cosB - Y * sinA * sinB - L * cosA;
    M[0] = qS * this.b * Cl;
    M[1] = qS * this.c * Cm;
    M[2] = qS * this.b * Cn;
    out.CL = CL; out.CD = CD; out.CY = CY; out.Cl = Cl; out.Cm = Cm; out.Cn = Cn; out.blend = w;
    return out;
  }
}
