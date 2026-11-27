import { describe, expect, it } from 'vitest';
import type { TurbofanEngineSpec } from '../core/types';
import { newPropulsionOutput, type PropulsionControls } from './propulsion';
import { TurbofanPropulsion, thrustFractionAtN1 } from './turbofan';

/** CFM56-5B-class: 120 kN static, about 0.36 lb/lbf/h at take-off. */
const SPEC: TurbofanEngineSpec = {
  type: 'turbofan', ratedThrustN: 120_000, tsfc: 1.0e-5, idleN1: 0.2, spoolTauS: 1.6, reverserFraction: 0.35,
  milThrust: { rows: [0, 0.4, 0.8], cols: [0, 11000], data: [1, 0.36, 0.78, 0.3, 0.68, 0.27] },
};
const air = { rho: 1.225, pAmb: 101325, tAmb: 288.15, u: 0, v: 0, w: 0 };
const ctl = (throttle: number, on = true): PropulsionControls => ({ throttle, mixture: on ? 1 : 0, magnetos: 3, starter: false, fuelAvailable: true });

function spool(e: TurbofanPropulsion, throttle: number, seconds: number, n1 = 0.2, reverse = false): number {
  const out = newPropulsionOutput();
  let egt = 600;
  const dt = 1 / 120;
  for (let t = 0; t < seconds; t += dt) {
    e.evaluate(n1, egt, air, ctl(throttle), [0, 0, 0], 0, 0, reverse, out);
    n1 += out.omegaDot * dt; egt += out.mapDot * dt;
  }
  return n1;
}

describe('turbofan', () => {
  const twin = () => { const e = new TurbofanPropulsion(SPEC, [[1, -5.7, 1.2], [1, 5.7, 1.2]]); e.lit = true; return e; };

  it('static take-off thrust ≈ 2 × 120 kN at full N1; 1–5 % at idle', () => {
    const out = newPropulsionOutput();
    twin().evaluate(1.0, 900, air, ctl(1), [0, 0, 0], 0, 0, false, out);
    expect(out.thrustN).toBeCloseTo(240_000, -3);
    expect(out.F[0]).toBeCloseTo(240_000, -3);
    // symmetric engines: no yawing moment; thrust line below the CG pitches the nose up (z down: r_z > 0)
    expect(Math.abs(out.M[2])).toBeLessThan(1e-6);
    expect(out.M[1]).toBeGreaterThan(0);
    expect(thrustFractionAtN1(0.2)).toBeGreaterThan(0.01);
    expect(thrustFractionAtN1(0.2)).toBeLessThan(0.05);
  });

  it('spools from idle to 95 % N1 in ≈ 5–8 s, and back down quicker', () => {
    const e = twin();
    let n1 = 0.2, t = 0;
    const out = newPropulsionOutput();
    while (n1 < 0.95 && t < 20) { e.evaluate(n1, 700, air, ctl(1), [0, 0, 0], 0, 0, false, out); n1 += out.omegaDot / 120; t += 1 / 120; }
    expect(t).toBeGreaterThan(4); expect(t).toBeLessThan(9);
    expect(spool(twin(), 0, 6, 1.0)).toBeLessThan(0.3);
  });

  it('fuel flow ≈ TSFC × thrust (≈ 2.4 kg/s for both at take-off); reversers push forward thrust backwards', () => {
    const out = newPropulsionOutput();
    twin().evaluate(1.0, 900, air, ctl(1), [0, 0, 0], 0, 0, false, out);
    expect(out.fuelFlowKgS).toBeCloseTo(2.4, 1);
    const rev = newPropulsionOutput();
    twin().evaluate(0.75, 900, air, ctl(0), [0, 0, 0], 0, 0, true, rev);
    expect(rev.thrustN).toBeLessThan(-40_000);
  });

  it('shut down (fuel lever off): no thrust, no fuel, N1 winds down; a start lights off at 18 %', () => {
    const e = twin();
    const out = newPropulsionOutput();
    e.evaluate(0.5, 800, air, ctl(1, false), [0, 0, 0], 0, 0, false, out);
    expect(e.lit).toBe(false);
    expect(out.thrustN).toBe(0); expect(out.fuelFlowKgS).toBe(0);
    expect(out.omegaDot).toBeLessThan(0);
    const s = new TurbofanPropulsion(SPEC, [[0, 0, 0]]);
    let n1 = 0;
    for (let t = 0; t < 40; t += 1 / 60) { s.evaluate(n1, 300, air, { ...ctl(0), starter: true }, [0, 0, 0], 0, 0, false, out); n1 += out.omegaDot / 60; }
    expect(s.lit).toBe(true);
    expect(n1).toBeGreaterThan(0.18);
  });
});
