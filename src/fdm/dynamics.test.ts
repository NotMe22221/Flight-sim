/**
 * Verification of the flight-model physics against closed-form answers: rigid-body invariants,
 * gravity, gyroscopic coupling, the wind→body force transform, the ARP→CG moment transfer,
 * propeller formulas and signs, Dryden turbulence statistics, and the dynamic modes measured
 * from pulse responses against docs/research/02 §10.
 */
import { describe, expect, it } from 'vitest';
import { qRotate } from '../core/math';
import { defaultControlInputs, type Vec3 } from '../core/types';
import { FT, KT, RPM_TO_RADS } from '../core/units';
import { AeroModel, newAeroOutput, type AeroInput, type AeroOutput } from './aero';
import { C172S } from './aircraft/c172';
import { atmosphere } from './atmosphere';
import type { Fdm } from './fdm';
import { PistonPropulsion, newPropulsionOutput, type PropulsionOutput } from './propulsion';
import { DrydenTurbulence, Rng } from './turbulence';
import { DT, KSFO, airborne, levelWings, makeEnv, makeFdm, run } from './testing';

const G = 9.80665;
interface Internals {
  y: Float64Array;
  mp: { mass: number; Ixx: number; Iyy: number; Izz: number; Ixz: number; cg: Vec3; inv: Float64Array };
  aero: { compute(i: AeroInput, o: AeroOutput): AeroOutput };
  prop: { evaluate(...a: unknown[]): PropulsionOutput };
  deriv(s: Float64Array, out: Float64Array): void;
  sampleEnvironment(): void;
}
const inner = (f: Fdm) => f as unknown as Internals;

/**
 * An aircraft in vacuum: aerodynamics replaced by a constant body force/moment at the ARP (zero by
 * default), propulsion by a rotor of constant angular momentum H along body x and no force.
 */
function vacuum(H = 0, aeroF: Vec3 = [0, 0, 0]) {
  const env = makeEnv();
  const f = makeFdm(1156);
  f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: 3000 }, headingRad: 0.3, speedMs: 50, onGround: false, engineRunning: false }, env);
  const I = inner(f);
  I.aero.compute = (_i, o) => { o.F[0] = aeroF[0]; o.F[1] = aeroF[1]; o.F[2] = aeroF[2]; o.M.fill(0); o.CL = o.CD = o.CY = o.Cl = o.Cm = o.Cn = 0; return o; };
  I.prop.evaluate = (...a: unknown[]) => {
    const o = a[5] as PropulsionOutput;
    Object.assign(o, newPropulsionOutput(), { F: o.F.fill(0), M: o.M.fill(0), angularMomentum: H });
    return o;
  };
  const u = defaultControlInputs();
  u.magnetos = 0; u.mixture = 0; u.parkingBrake = false;
  return { f, I, env, u };
}

function invariants(I: Internals, H: number) {
  const { mp, y } = I;
  const p = y[10], q = y[11], r = y[12];
  const Lb: Vec3 = [mp.Ixx * p - mp.Ixz * r + H, mp.Iyy * q, mp.Izz * r - mp.Ixz * p];
  const qbn: [number, number, number, number] = [y[6], y[7], y[8], y[9]];
  const Ln = qRotate(qbn, Lb, [0, 0, 0]);
  const vn = qRotate(qbn, [y[3], y[4], y[5]], [0, 0, 0]);
  const energy = 0.5 * (vn[0] ** 2 + vn[1] ** 2 + vn[2] ** 2) - G * y[2]; // per unit mass, D down
  const rotKE = 0.5 * (p * (mp.Ixx * p - mp.Ixz * r) + q * mp.Iyy * q + r * (mp.Izz * r - mp.Ixz * p));
  return { Ln, energy, rotKE, vn };
}

describe('equations of motion (closed-form checks)', () => {
  it('torque-free tumbling ballistic flight conserves energy, rotational energy and inertial angular momentum (Ixz ≠ 0, spinning rotor)', () => {
    for (const H of [0, 640]) {
      const { f, I, env, u } = vacuum(H);
      expect(Math.abs(I.mp.Ixz)).toBeGreaterThan(1); // the loaded aircraft has a product of inertia
      const y = I.y;
      y[3] = 50; y[4] = 10; y[5] = -5; y[10] = 0.8; y[11] = 0.5; y[12] = -0.6;
      const i0 = invariants(I, H);
      let dE = 0, dR = 0, dL = 0;
      run(f, env, u, 20, () => {
        const i1 = invariants(I, H);
        dE = Math.max(dE, Math.abs(i1.energy - i0.energy));
        dR = Math.max(dR, Math.abs(i1.rotKE - i0.rotKE));
        dL = Math.max(dL, Math.hypot(i1.Ln[0] - i0.Ln[0], i1.Ln[1] - i0.Ln[1], i1.Ln[2] - i0.Ln[2]));
      });
      expect(f.state.crashed).toBe(false);
      expect(dE / i0.energy).toBeLessThan(1e-8);
      expect(dR / i0.rotKE).toBeLessThan(1e-8);
      expect(dL / Math.hypot(...i0.Ln)).toBeLessThan(1e-8);
    }
  });

  it('gravity: released from rest in an arbitrary attitude, the aircraft falls straight down at g', () => {
    const { f, I, env, u } = vacuum();
    const y = I.y;
    const n = Math.hypot(0.7, 0.3, -0.5, 0.4);
    y[6] = 0.7 / n; y[7] = 0.3 / n; y[8] = -0.5 / n; y[9] = 0.4 / n;
    y[3] = y[4] = y[5] = 0; y[10] = y[11] = y[12] = 0;
    const p0 = [y[0], y[1], y[2]];
    run(f, env, u, 2);
    const t = f.state.t;
    expect(f.state.velNED[0]).toBeCloseTo(0, 9);
    expect(f.state.velNED[1]).toBeCloseTo(0, 9);
    expect(f.state.velNED[2]).toBeCloseTo(G * t, 9);
    expect(y[2] - p0[2]).toBeCloseTo(0.5 * G * t * t, 7);
    expect(Math.hypot(y[0] - p0[0], y[1] - p0[1])).toBeLessThan(1e-9);
    expect(f.state.loadFactor[2]).toBeCloseTo(0, 12); // free fall: no specific force
  });

  it('gyroscopic coupling: pitching up with a clockwise (from behind) propeller yaws the nose right', () => {
    const H = 640;
    const { I } = vacuum(H);
    const y = I.y;
    y[10] = 0; y[11] = 0.5; y[12] = 0;
    const k = new Float64Array(15);
    I.sampleEnvironment(); I.deriv(y, k);
    // M = −ω × (Iω + H) → Mz = q·(Ixx·p − Ixz·r + H) − p·Iyy·q = q·H for p = r = 0; Mx = −q·(Izz·r − Ixz·p) = 0
    const inv = I.mp.inv;
    expect(k[12]).toBeGreaterThan(0);
    expect(k[12]).toBeCloseTo(inv[8] * 0.5 * H, 9);
    expect(k[10]).toBeCloseTo(inv[2] * 0.5 * H, 9);
  });

  it('a pure force at the aerodynamic reference point produces exactly (r_ARP − r_CG) × F about the CG', () => {
    const F: Vec3 = [300, -200, -6000];
    const { I } = vacuum(0, F);
    const y = I.y;
    y[10] = y[11] = y[12] = 0;
    const k = new Float64Array(15);
    I.sampleEnvironment(); I.deriv(y, k);
    const a = C172S.geometry.arpOffset, cg = I.mp.cg;
    const r = [a[0] - cg[0], a[1] - cg[1], a[2] - cg[2]];
    const M = [r[1] * F[2] - r[2] * F[1], r[2] * F[0] - r[0] * F[2], r[0] * F[1] - r[1] * F[0]];
    const inv = I.mp.inv;
    expect(k[10]).toBeCloseTo(inv[0] * M[0] + inv[2] * M[2], 9);
    expect(k[11]).toBeCloseTo(inv[4] * M[1], 9);
    expect(k[12]).toBeCloseTo(inv[6] * M[0] + inv[8] * M[2], 9);
    // the ARP is above and slightly aft of the CG: lift (−z) behind the CG pitches nose down
    expect(M[1]).toBeLessThan(0);
  });
});

describe('aerodynamic force transform (wind → body)', () => {
  const m = new AeroModel(C172S);
  const o = newAeroOutput();
  it('drag acts along −V, side force along the wind y axis, lift perpendicular to both, for any α, β', () => {
    for (const ad of [-170, -60, -15, 0, 7, 16, 40, 95, 150]) for (const bd of [-60, -10, 0, 25]) {
      const al = (ad * Math.PI) / 180, be = (bd * Math.PI) / 180, V = 40, rho = 1.2, qb = 0.5 * rho * V * V;
      const i: AeroInput = { alpha: al, beta: be, V, rho, qbar: qb, qbarUW: qb, qbarTail: qb, qbarInduced: 0, propSense: 1, p: 0, q: 0, r: 0, alphaDot: 0, de: 0.05, da: 0.02, dr: -0.03, flapDeg: 10, hOverB: Infinity, hyst: 0 };
      m.compute(i, o);
      const qS = qb * C172S.geometry.S;
      const xw = [Math.cos(al) * Math.cos(be), Math.sin(be), Math.sin(al) * Math.cos(be)];
      const yw = [-Math.cos(al) * Math.sin(be), Math.cos(be), -Math.sin(al) * Math.sin(be)];
      const zw = [-Math.sin(al), 0, Math.cos(al)];
      const dot = (a: number[]) => a[0] * o.F[0] + a[1] * o.F[1] + a[2] * o.F[2];
      expect(dot(xw)).toBeCloseTo(-qS * o.CD, 6);
      expect(dot(yw)).toBeCloseTo(qS * o.CY, 6);
      expect(dot(zw)).toBeCloseTo(-qS * o.CL, 6);
    }
  });
});
