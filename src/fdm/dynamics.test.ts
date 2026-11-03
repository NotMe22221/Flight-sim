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
import { DT, KSFO, SpeedHold, airborne, levelWings, makeEnv, makeFdm, run } from './testing';

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

// ───────────────────────────── propeller and engine ─────────────────────────────

describe('propeller and engine: formulas, units and signs', () => {
  const eng = C172S.propulsion.engine as never;
  const pr = C172S.propulsion.propeller!;
  const p = new PistonPropulsion(eng, pr);
  const sl = atmosphere(0);
  const air = (u: number, v = 0, w = 0) => ({ rho: sl.densityKgM3, pAmb: sl.pressurePa, tAmb: sl.temperatureK, u, v, w });
  const full = { throttle: 1, mixture: 1, magnetos: 3 as const, starter: false, fuelAvailable: true };
  const hub: Vec3 = [2, 0, 0.25];
  const D = pr.diameterM;

  it('T = Ct(J)·ρn²D⁴ and Q = Cp(J)·ρn²D⁵/2π with J = V/(nD); J² extrapolation is continuous', () => {
    const n = 40, o = newPropulsionOutput();
    p.evaluate(n * 2 * Math.PI, 90000, air(0.5 * n * D), full, hub, o);
    expect(o.thrustN).toBeCloseTo(0.082 * sl.densityKgM3 * n * n * D ** 4, 6);
    expect(o.propTorqueNm).toBeCloseTo((0.058 / (2 * Math.PI)) * sl.densityKgM3 * n * n * D ** 5, 6);
    const jMax = pr.Ct.xs[pr.Ct.xs.length - 1];
    const a = newPropulsionOutput(), b = newPropulsionOutput();
    p.evaluate(n * 2 * Math.PI, 90000, air(jMax * n * D * (1 - 1e-9)), full, hub, a);
    p.evaluate(n * 2 * Math.PI, 90000, air(jMax * n * D * (1 + 1e-9)), full, hub, b);
    expect(b.thrustN / a.thrustN).toBeCloseTo(1, 6);
    expect(b.propTorqueNm / a.propTorqueNm).toBeCloseTo(1, 6);
    // a stopped propeller in a 40 m/s airstream drags and is driven (windmills)
    p.evaluate(0, sl.pressurePa, air(40), { ...full, magnetos: 0 }, hub, a);
    expect(a.thrustN).toBeLessThan(0);
    expect(a.omegaDot).toBeGreaterThan(0);
  });

  it('brake-specific fuel consumption at full power is 0.40–0.60 lb/hp/h (lb/hr, hp and kg/s consistent)', () => {
    const eq = p.equilibrium(air(30), full, 2400 * RPM_TO_RADS, 90000);
    const o = newPropulsionOutput();
    p.evaluate(eq.omega, eq.map, air(30), full, hub, o);
    const lbPerHr = (o.fuelFlowKgS * 3600) / 0.45359237, bhp = o.brakePowerW / 745.7;
    expect(bhp).toBeGreaterThan(130);
    expect(lbPerHr / bhp).toBeGreaterThan(0.4);
    expect(lbPerHr / bhp).toBeLessThan(0.6);
    expect(o.fuelFlowKgS * 3600 / 0.72 / 3.785411784).toBeGreaterThan(11); // ≈ 13–15 gph take-off flow
  });

  it('signs for a clockwise (from behind) propeller: left-roll reaction, positive α yaws left, rotor momentum along +x', () => {
    const w = 2400 * RPM_TO_RADS, o0 = newPropulsionOutput(), oa = newPropulsionOutput();
    p.evaluate(w, 95000, air(35), full, hub, o0);
    expect(o0.combusting).toBe(true);
    expect(o0.M[0]).toBeLessThan(-300); // ≈ engine torque, rolling left
    expect(o0.angularMomentum).toBeCloseTo((C172S.propulsion.engine as { inertia: number }).inertia * w + pr.inertia * w, 6);
    p.evaluate(w, 95000, air(35, 0, 35 * Math.tan(0.15)), full, hub, oa);
    expect(oa.M[2]).toBeLessThan(o0.M[2] - 50); // P-factor: thrust line moves right → nose left
    // sideslip from the right (v > 0): the up-going blade side loads up → thrust line moves up → nose down
    p.evaluate(w, 95000, air(35, 35 * Math.tan(0.15), 0), full, hub, oa);
    expect(oa.M[1]).toBeLessThan(o0.M[1] - 50);
  });
});

// ───────────────────────────── Dryden turbulence ─────────────────────────────

describe('Dryden turbulence statistics (MIL-F-8785C)', () => {
  function sigma(aglM: number, V: number, w20Kt: number, intensity: 0 | 3 | 4 | 5, seed = 12345, seconds = 1500) {
    const t = new DrydenTurbulence(new Rng(seed), C172S.geometry.b);
    const n = Math.round(seconds / DT), s = new Float64Array(4), s2 = new Float64Array(4);
    for (let i = 0; i < n; i++) {
      const o = t.step(DT, aglM, V, w20Kt, intensity, 0.7, 0);
      const v = [o.velNED[0], o.velNED[1], o.velNED[2], Math.hypot(o.pqr[0], o.pqr[1]) * Math.sign(o.pqr[0])];
      for (let k = 0; k < 4; k++) { s[k] += v[k]; s2[k] += v[k] * v[k]; }
    }
    return Array.from(s2, (x, k) => Math.sqrt(x / n - (s[k] / n) ** 2));
  }

  it('low altitude: σu = σv = σw/(0.177+0.000823h)^0.4, σw = 0.1·W20 within ±20 % (ft ↔ m handled)', () => {
    for (const [agl, V] of [[150, 50], [30, 40], [300, 60]]) {
      const hFt = agl / FT, w20 = (30 * KT) / FT;
      const sw = 0.1 * w20 * FT, su = sw / Math.pow(0.177 + 0.000823 * hFt, 0.4);
      const [sN, sE, sD] = sigma(agl, V, 30, 4);
      // horizontal components are rotated by the wind azimuth: compare the total horizontal variance
      expect(Math.hypot(sN, sE) / (Math.SQRT2 * su)).toBeGreaterThan(0.8);
      expect(Math.hypot(sN, sE) / (Math.SQRT2 * su)).toBeLessThan(1.2);
      expect(sD / sw).toBeGreaterThan(0.8);
      expect(sD / sw).toBeLessThan(1.2);
    }
  });

  it('medium altitude: σ from the probability-of-exceedance table (moderate, 3000 m) within ±20 %', () => {
    const hFt = 3000 / FT; // between the 7 500 ft and 15 000 ft columns of row 4
    const sTab = (10.1 + ((8.0 - 10.1) * (hFt - 7500)) / 7500) * FT;
    const [sN, sE, sD] = sigma(3000, 60, 0, 4);
    expect(sD / sTab).toBeGreaterThan(0.8);
    expect(sD / sTab).toBeLessThan(1.2);
    expect(Math.hypot(sN, sE) / (Math.SQRT2 * sTab)).toBeGreaterThan(0.8);
    expect(Math.hypot(sN, sE) / (Math.SQRT2 * sTab)).toBeLessThan(1.2);
  });

  it('is seeded and deterministic, and silent when turned off', () => {
    const a = sigma(150, 50, 30, 4, 7, 20), b = sigma(150, 50, 30, 4, 7, 20), c = sigma(150, 50, 30, 4, 8, 20);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(sigma(150, 50, 0, 0, 7, 20)).toEqual([0, 0, 0, 0]);
  });
});

// ───────────────────────────── dynamic modes from pulse responses ─────────────────────────────

interface Mode { re: number; im: number; wn: number; zeta: number; period: number; tau: number }

/**
 * Modes of a free response: least-squares AR(n) fit x[k] = Σ aᵢ·x[k−i] (Prony), roots of the
 * characteristic polynomial by Durand–Kerner, mapped to continuous time λ = ln z / h.
 */
function freeResponseModes(x: number[], n: number, h: number): Mode[] {
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0)), b = new Array<number>(n).fill(0);
  for (let k = n; k < x.length; k++) for (let i = 0; i < n; i++) { b[i] += x[k] * x[k - 1 - i]; for (let j = 0; j < n; j++) A[i][j] += x[k - 1 - i] * x[k - 1 - j]; }
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < n; r++) { const f = A[r][c] / A[c][c]; for (let j = c; j < n; j++) A[r][j] -= f * A[c][j]; b[r] -= f * b[c]; }
  }
  const a = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let j = r + 1; j < n; j++) s -= A[r][j] * a[j]; a[r] = s / A[r][r]; }
  const co = [1, ...a.map((v) => -v)];
  const zr = Array.from({ length: n }, (_, k) => 0.9 * Math.cos(0.4 + (2 * Math.PI * k) / n));
  const zi = Array.from({ length: n }, (_, k) => 0.9 * Math.sin(0.4 + (2 * Math.PI * k) / n));
  for (let it = 0; it < 500; it++) {
    for (let k = 0; k < n; k++) {
      let vr = co[0], vi = 0, pr = 1, pi = 0;
      for (let j = 1; j <= n; j++) { const t = vr * zr[k] - vi * zi[k] + co[j]; vi = vr * zi[k] + vi * zr[k]; vr = t; }
      for (let j = 0; j < n; j++) if (j !== k) { const dr = zr[k] - zr[j], di = zi[k] - zi[j], t = pr * dr - pi * di; pi = pr * di + pi * dr; pr = t; }
      const den = pr * pr + pi * pi || 1e-300;
      zr[k] -= (vr * pr + vi * pi) / den; zi[k] -= (vi * pr - vr * pi) / den;
    }
  }
  return zr.map((r, k) => {
    const re = Math.log(Math.hypot(r, zi[k])) / h, im = Math.atan2(zi[k], r) / h, wn = Math.hypot(re, im);
    return { re, im, wn, zeta: -re / wn, period: Math.abs(im) > 1e-9 ? (2 * Math.PI) / Math.abs(im) : Infinity, tau: -1 / re };
  });
}
/** One member (positive frequency) of each complex pair with ωn in (wLo, wHi). */
const oscillatory = (m: Mode[], wLo: number, wHi: number) => m.filter((x) => x.im > 1e-6 && x.wn > wLo && x.wn < wHi);

describe('dynamic modes vs docs/research/02 §10 (C172S 2 550 lb, 100 KCAS)', () => {
  it('short period (elevator pulse, q response): period 1–1.5 s, ζ 0.6–0.8', () => {
    const env = makeEnv();
    const f = makeFdm(1156);
    const u = airborne(f, env, 300, 100);
    const base = u.pitch, q: number[] = [];
    run(f, env, u, 4, (t) => {
      levelWings(f, u);
      u.pitch = t < 0.25 ? base + 0.3 : base;
      if (t >= 0.5 && Math.round(t / DT) % 4 === 0) q.push(f.state.rates[1]);
    });
    const sp = oscillatory(freeResponseModes(q, 4, 4 * DT), 3, 15);
    expect(sp.length).toBe(1);
    expect(sp[0].period).toBeGreaterThan(1);
    expect(sp[0].period).toBeLessThan(1.5);
    expect(sp[0].zeta).toBeGreaterThan(0.6);
    expect(sp[0].zeta).toBeLessThan(0.8);
  });

  it('phugoid (elevator pulse, airspeed response): period 20–30 s, lightly damped (0 < ζ < 0.2)', () => {
    const env = makeEnv();
    const f = makeFdm(1156);
    const u = airborne(f, env, 1000, 100);
    const base = u.pitch, v: number[] = [];
    run(f, env, u, 150, (t) => {
      levelWings(f, u);
      u.pitch = t < 1 ? base + 0.15 : base;
      if (t >= 5 && Math.round(t / DT) % 60 === 0) v.push(f.state.aero.tas);
    });
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const ph = oscillatory(freeResponseModes(v.map((s) => s - mean), 4, 0.5), 0.1, 0.6);
    expect(ph.length).toBe(1);
    expect(ph[0].period).toBeGreaterThan(20);
    expect(ph[0].period).toBeLessThan(30);
    expect(ph[0].zeta).toBeGreaterThan(0);
    expect(ph[0].zeta).toBeLessThan(0.2);
  });

  it('dutch roll (rudder pulse, sideslip response): ωn 2–3 rad/s, ζ 0.1–0.25', () => {
    const env = makeEnv();
    const f = makeFdm(1156);
    const u = airborne(f, env, 1000, 100);
    const beta: number[] = [];
    run(f, env, u, 8, (t) => {
      u.yaw = t < 0.4 ? 0.4 : 0;
      if (t >= 0.8 && Math.round(t / DT) % 4 === 0) beta.push(f.state.aero.beta);
    });
    const dr = oscillatory(freeResponseModes(beta, 4, 4 * DT), 1.5, 4);
    expect(dr.length).toBe(1);
    expect(dr[0].wn).toBeGreaterThan(2);
    expect(dr[0].wn).toBeLessThan(3);
    expect(dr[0].zeta).toBeGreaterThan(0.1);
    expect(dr[0].zeta).toBeLessThan(0.25);
  });

  it('roll subsidence (aileron pulse, roll-rate response): τ 0.1–0.2 s', () => {
    const env = makeEnv();
    const f = makeFdm(1156);
    const u = airborne(f, env, 1000, 100);
    const p: number[] = [];
    run(f, env, u, 3, (t) => {
      u.roll = t < 0.3 ? 0.5 : 0;
      if (t >= 0.45 && Math.round(t / DT) % 2 === 0) p.push(f.state.rates[0]);
    });
    const roll = freeResponseModes(p, 4, 2 * DT).filter((m) => Math.abs(m.im) < 1e-6 && m.tau > 0.05 && m.tau < 1);
    expect(roll.length).toBeGreaterThanOrEqual(1);
    const tau = roll.sort((a, b) => b.tau - a.tau)[0].tau;
    expect(tau).toBeGreaterThan(0.1);
    expect(tau).toBeLessThan(0.2);
  });

  it('spiral (lateral trim held, released from ±10° bank): neutral to slowly divergent, time to double > 30 s', () => {
    for (const bank of [10, -10]) {
      const env = makeEnv();
      const f = makeFdm(1156);
      const u = airborne(f, env, 1500, 100);
      let ra = 0, ya = 0, n = 0;
      run(f, env, u, 30, (t) => { levelWings(f, u); if (t > 20) { ra += u.roll; ya += u.yaw; n++; } });
      const aTrim = ra / n, rTrim = ya / n;
      run(f, env, u, 4, () => { u.roll = Math.max(-1, Math.min(1, aTrim + 2 * ((bank * Math.PI) / 180 - f.state.euler[0]) - 0.4 * f.state.rates[0])); u.yaw = rTrim; });
      const phi0 = f.state.euler[0];
      u.roll = aTrim; u.yaw = rTrim;
      run(f, env, u, 30);
      const ratio = f.state.euler[0] / phi0;
      expect(ratio).toBeGreaterThan(0.3); // not strongly convergent (and no reversal)
      expect(ratio).toBeLessThan(2); // T₂ > 30 s
    }
  });
});

// ───────────────────────────── handling qualities ─────────────────────────────

describe('feel: left-turning tendencies and the stall', () => {
  it('take-off roll needs moderate right rudder early (not a fight), little by rotation; climb at Vy needs a touch', () => {
    const env = makeEnv();
    const f = makeFdm(1156);
    f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: true }, env);
    const u = defaultControlInputs();
    u.parkingBrake = false; u.throttle = 1; u.magnetos = 3; u.mixture = 1;
    const early: number[] = [], late: number[] = [];
    let integ = 0, maxErr = 0;
    run(f, env, u, 25, () => {
      const s = f.state;
      let e = -s.headingTrueRad;
      while (e < -Math.PI) e += 2 * Math.PI;
      while (e > Math.PI) e -= 2 * Math.PI;
      integ += e * DT;
      maxErr = Math.max(maxErr, Math.abs(e));
      u.yaw = Math.max(-1, Math.min(1, 3 * e - 0.8 * s.rates[2] + integ));
      const kias = s.aero.ias / KT;
      if (s.onGround && kias > 3 && kias < 20) early.push(u.yaw);
      if (s.onGround && kias > 45 && kias < 55) late.push(u.yaw);
    });
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(early)).toBeGreaterThan(0.08); // right rudder
    expect(mean(early)).toBeLessThan(0.5);
    expect(mean(late)).toBeGreaterThan(0);
    expect(mean(late)).toBeLessThan(0.2);
    expect(maxErr * 57.3).toBeLessThan(6);

    // coordinated full-power climb at Vy
    const g = makeFdm(1156);
    const v = airborne(g, makeEnv(), 300, 74);
    v.throttle = 1;
    const hold = new SpeedHold(g, 74, v.pitch);
    let yi = 0;
    run(g, env, v, 25, () => {
      const s = g.state;
      hold.update(v, DT);
      v.roll = Math.max(-1, Math.min(1, -2 * s.euler[0] - 0.4 * s.rates[0]));
      yi += 4 * s.aero.beta * DT;
      v.yaw = Math.max(-1, Math.min(1, 10 * s.aero.beta + yi));
    });
    expect(Math.abs(g.state.aero.beta)).toBeLessThan(0.005);
    expect(v.yaw).toBeGreaterThan(0.05);
    expect(v.yaw).toBeLessThan(0.35);
  });

  /** Power-off 1 g stall entry at ≈ 1 kt/s, full back stick through the break, ailerons neutral. */
  function stall(pedal: 'coordinated' | 'left' | 'right') {
    const env = makeEnv();
    const f = makeFdm(1156);
    const u = airborne(f, env, 1500, 70);
    u.throttle = 0;
    const h0 = f.state.altitudeMslM;
    let stick = u.pitch, tStall = NaN, maxBank = 0, minPitch = 1;
    run(f, env, u, 30, (t) => {
      const s = f.state;
      if (Number.isNaN(tStall) && (s.aero.alpha > 0.3 || s.aero.stalled)) tStall = t;
      if (Number.isNaN(tStall)) {
        stick = Math.max(-1, Math.min(1, stick + (0.02 * (h0 - s.altitudeMslM) - 0.08 * s.verticalSpeedMs) * DT));
        u.pitch = Math.max(-1, Math.min(1, stick - 0.35 * s.rates[1]));
        u.roll = Math.max(-1, Math.min(1, -2 * s.euler[0] - 0.4 * s.rates[0]));
      } else if (t - tStall < 4) {
        u.pitch = 1; u.roll = 0;
        maxBank = Math.max(maxBank, Math.abs(s.euler[0]));
        minPitch = Math.min(minPitch, s.euler[1]);
      } else { u.pitch = 0; u.roll = 0; }
      if (pedal === 'coordinated') u.yaw = Math.max(-1, Math.min(1, 10 * s.aero.beta));
      else u.yaw = (pedal === 'left' ? -0.6 : 0.6) * Math.min(1, t / 10);
    });
    return { tStall, maxBankDeg: maxBank * 57.3, minPitchDeg: minPitch * 57.3, crashed: f.state.crashed };
  }

  it('a coordinated 1 g stall is benign: the nose drops, the wings stay within 15°', () => {
    const r = stall('coordinated');
    expect(Number.isNaN(r.tStall)).toBe(false);
    expect(r.maxBankDeg).toBeLessThan(15);
    expect(r.minPitchDeg).toBeLessThan(0); // nose falls through the horizon
    expect(r.crashed).toBe(false);
  });

  it('a cross-controlled (skidding) stall drops a wing', () => {
    for (const side of ['left', 'right'] as const) {
      const r = stall(side);
      expect(Number.isNaN(r.tStall)).toBe(false);
      expect(r.maxBankDeg, side).toBeGreaterThan(30);
    }
  });
});

// ───────────────────────────── ground contact ─────────────────────────────

describe('ground contact: frames, tyre force signs and brake anchors', () => {
  it('a sliding wheel is pushed against its slip; a right-steered nose wheel pulls right (right = down × forward)', async () => {
    const { GearModel } = await import('./gear');
    const spec = { ...C172S.gear[0], pos: [1.2, 0, 1] as Vec3 }; // 1.2 m ahead of the CG, like the nose wheel
    const g = new GearModel([spec]);
    const out = g.newOutput();
    const env = makeEnv({ groundAltM: KSFO.elev });
    const ground = env.groundHeight(0, 0);
    const pos = [0, 0, -ground - 1 + 0.05]; // 5 cm compression, level attitude, heading north
    const q: [number, number, number, number] = [1, 0, 0, 0];
    const ctl = { brakeLeft: 0, brakeRight: 0, steerRad: 0 };
    g.evaluate(pos, q, [0, 2, 0], [0, 0, 0], [0, 0, 0], 1156, env, ctl, DT, out); // sliding right
    expect(out.sideSpeed[0]).toBeCloseTo(2, 9); // body right = east = down × north
    expect(out.F[1]).toBeLessThan(0);
    g.evaluate(pos, q, [10, 0, 0], [0, 0, 0], [0, 0, 0], 1156, env, { ...ctl, steerRad: 0.1 }, DT, out);
    expect(out.F[1]).toBeGreaterThan(0); // steered right while rolling straight → side force to the right
    expect(out.F[0]).toBeLessThan(0); // rolling resistance
    expect(out.M[2]).toBeGreaterThan(0); // ahead of the CG → yaws right
  });

  it('brake anchors never grab a rolling wheel, hold it once stopped, and let go when the brakes are released', () => {
    const env = makeEnv();
    const f = makeFdm(1156);
    f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: true }, env);
    const anchored = (f as unknown as { gear: { anchored: Uint8Array } }).gear.anchored;
    const u = defaultControlInputs();
    u.parkingBrake = false; u.magnetos = 3; u.mixture = 1; u.throttle = 0.35;
    run(f, env, u, 6); // taxi
    expect(f.state.groundSpeedMs).toBeGreaterThan(2);
    expect(Array.from(anchored).some((a) => a)).toBe(false);
    u.throttle = 0; u.brakeLeft = u.brakeRight = 0.6;
    let grabbedWhileRolling = false;
    run(f, env, u, 8, () => { if (f.state.groundSpeedMs > 0.2 && Array.from(anchored).some((a) => a)) grabbedWhileRolling = true; });
    expect(grabbedWhileRolling).toBe(false);
    expect(f.state.groundSpeedMs).toBeLessThan(0.01);
    expect(anchored[1] && anchored[2]).toBeTruthy();
    u.brakeLeft = u.brakeRight = 0; u.throttle = 0.35;
    run(f, env, u, 3);
    expect(Array.from(anchored).some((a) => a)).toBe(false);
    expect(f.state.groundSpeedMs).toBeGreaterThan(0.5);
  });
});
