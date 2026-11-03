import { describe, expect, it } from 'vitest';
import { C172S } from './aircraft/c172';
import { AeroModel, newAeroOutput, type AeroInput } from './aero';

const base = (over: Partial<AeroInput> = {}): AeroInput => {
  const V = 50, rho = 1.225, q = 0.5 * rho * V * V;
  return { alpha: 0.05, beta: 0, V, rho, qbar: q, qbarUW: q, qbarTail: q, qbarInduced: 0, propSense: 1, p: 0, q: 0, r: 0, alphaDot: 0, de: 0, da: 0, dr: 0, flapDeg: 0, hOverB: Infinity, hyst: 0, ...over };
};

describe('AeroModel', () => {
  const m = new AeroModel(C172S);
  const o = newAeroOutput();

  it('lift curve: CL(0)=0.25, CLmax ≈ 1.57 at 16°, drop past stall', () => {
    expect(m.compute(base({ alpha: 0 }), o).CL).toBeCloseTo(0.25, 6);
    expect(m.compute(base({ alpha: 0.28 }), o).CL).toBeCloseTo(1.57, 6);
    expect(m.compute(base({ alpha: 0.34 }), o).CL).toBeLessThan(1.4);
    expect(m.compute(base({ alpha: 0.2, hyst: 1 }), o).CL).toBeLessThan(m.compute(base({ alpha: 0.2 }), o).CL);
  });

  it('flaps add lift and drag and pitch nose-down', () => {
    const clean = { ...m.compute(base(), o) };
    const full = { ...m.compute(base({ flapDeg: 30 }), o) };
    expect(full.CL - clean.CL).toBeCloseTo(0.35 * Math.cos(0.05) ** 2, 3);
    expect(full.CD).toBeGreaterThan(clean.CD + 0.03);
    expect(full.Cm).toBeLessThan(clean.Cm);
  });

  it('ground effect raises lift and cuts induced drag', () => {
    const free = { ...m.compute(base({ alpha: 0.1 }), o) };
    const ge = { ...m.compute(base({ alpha: 0.1, hOverB: 0.1 }), o) };
    expect(ge.CL / free.CL).toBeGreaterThan(1.1);
    expect(ge.CD).toBeLessThan(free.CD);
  });

  it('control signs: elevator TE down pitches nose down, aileron + rolls right, rudder + yaws left', () => {
    expect(m.compute(base({ de: 0.1 }), o).Cm).toBeLessThan(m.compute(base(), o).Cm);
    expect(m.compute(base({ da: 0.1 }), o).Cl).toBeGreaterThan(0);
    expect(m.compute(base({ dr: 0.1 }), o).Cn).toBeLessThan(0);
  });

  it('static stability: Cmα < 0, Cnβ > 0 (weathercock), Clβ < 0 (dihedral)', () => {
    expect(m.compute(base({ alpha: 0.1 }), o).Cm).toBeLessThan(m.compute(base({ alpha: 0.0 }), o).Cm);
    expect(m.compute(base({ beta: 0.1 }), o).Cn).toBeGreaterThan(0);
    expect(m.compute(base({ beta: 0.1 }), o).Cl).toBeLessThan(0);
  });

  it('damping: Clp, Cmq, Cnr oppose the rates', () => {
    expect(m.compute(base({ p: 1 }), o).Cl).toBeLessThan(0);
    expect(m.compute(base({ q: 1 }), o).Cm).toBeLessThan(m.compute(base(), o).Cm);
    expect(m.compute(base({ r: 1 }), o).Cn).toBeLessThan(0);
  });

  it('body forces: lift points up (−z) at small α; drag points aft', () => {
    const r = m.compute(base({ alpha: 0.05 }), o);
    expect(r.F[2]).toBeLessThan(0);
    expect(r.F[0]).toBeLessThan(500); // drag minus forward lift tilt; small
    const r0 = m.compute(base({ alpha: 0 }), o);
    expect(r0.F[0]).toBeLessThan(0);
  });

  it('finite and continuous for every attitude (flat-plate blend)', () => {
    let prev: number | null = null;
    for (let deg = -180; deg <= 180; deg += 0.5) {
      const a = (deg * Math.PI) / 180;
      for (const bdeg of [-90, -30, 0, 30, 90]) {
        const r = m.compute(base({ alpha: a, beta: (bdeg * Math.PI) / 180, p: 0.5, r: -0.5, de: 0.3, flapDeg: 20 }), o);
        for (const v of [...r.F, ...r.M, r.CL, r.CD, r.CY, r.Cl, r.Cm, r.Cn]) expect(Number.isFinite(v)).toBe(true);
        expect(r.CD).toBeGreaterThan(0);
      }
      const cl = m.compute(base({ alpha: a }), o).CL;
      if (prev !== null && Math.abs(deg) > 1) expect(Math.abs(cl - prev)).toBeLessThan(0.12);
      prev = cl;
    }
  });

  it('robust at zero airspeed', () => {
    const r = m.compute(base({ V: 0, qbar: 0, qbarUW: 0, qbarTail: 0, p: 1, q: 1, r: 1, alphaDot: 1 }), o);
    for (const v of [...r.F, ...r.M]) { expect(Number.isFinite(v)).toBe(true); expect(Math.abs(v)).toBeLessThan(1e-3); }
  });

  it('hysteresis: switches on above 0.36 rad and off below 0.09 rad', () => {
    expect(m.updateHysteresis(0.37, 0)).toBe(1);
    expect(m.updateHysteresis(0.2, 1)).toBe(1);
    expect(m.updateHysteresis(0.08, 1)).toBe(0);
    expect(m.updateHysteresis(0.3, 0)).toBe(0);
  });
});
