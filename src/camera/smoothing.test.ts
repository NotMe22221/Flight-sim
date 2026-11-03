import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DampedSpringScalar, SpringScalar, SpringVector3, coastStep, expSmoothing, omegaFromTau, smoothAngle } from './smoothing';

describe('expSmoothing', () => {
  it('is frame-rate independent: 1 s at 30 Hz equals 1 s at 240 Hz', () => {
    const run = (hz: number) => {
      let x = 0; const dt = 1 / hz;
      for (let i = 0; i < hz; i++) x += (1 - x) * expSmoothing(dt, 0.3);
      return x;
    };
    expect(run(30)).toBeCloseTo(run(240), 10);
    expect(run(60)).toBeCloseTo(1 - Math.exp(-1 / 0.3), 10);
  });
});

describe('SpringScalar', () => {
  it('converges to the target without overshoot', () => {
    const s = new SpringScalar(omegaFromTau(0.35));
    s.reset(10);
    let prev = 10;
    for (let i = 0; i < 120; i++) {
      const x = s.update(0, 1 / 60);
      expect(x).toBeLessThanOrEqual(prev + 1e-12);
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      prev = x;
    }
    expect(Math.abs(s.x)).toBeLessThan(0.01);
  });

  it('is independent of the step size for a fixed target', () => {
    const a = new SpringScalar(5); a.reset(1);
    const b = new SpringScalar(5); b.reset(1);
    for (let i = 0; i < 100; i++) a.update(0, 0.01);
    b.update(0, 1.0);
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.v).toBeCloseTo(b.v, 9);
  });

  it('trails a ramp by 2/ω (the τ parameter)', () => {
    const tau = 0.35;
    const s = new SpringScalar(omegaFromTau(tau));
    s.reset(0);
    const dt = 1 / 120; let t = 0;
    for (let i = 0; i < 1200; i++) { t += dt; s.update(t * 10, dt); }
    // the target is sampled at the end of each step, which removes half a step of lag
    expect(t * 10 - s.x).toBeCloseTo(10 * tau - 10 * dt / 2, 3);
  });
});

describe('SpringVector3', () => {
  it('matches three scalar springs and allocates nothing per update', () => {
    const v = new SpringVector3(6);
    v.reset(new THREE.Vector3(1, -2, 3));
    const sx = new SpringScalar(6), sy = new SpringScalar(6), sz = new SpringScalar(6);
    sx.reset(1); sy.reset(-2); sz.reset(3);
    const target = new THREE.Vector3(0, 1, 0);
    const posRef = v.pos;
    for (let i = 0; i < 50; i++) {
      v.update(target, 1 / 60); sx.update(0, 1 / 60); sy.update(1, 1 / 60); sz.update(0, 1 / 60);
    }
    expect(v.pos).toBe(posRef);
    expect(v.pos.x).toBeCloseTo(sx.x, 12);
    expect(v.pos.y).toBeCloseTo(sy.x, 12);
    expect(v.pos.z).toBeCloseTo(sz.x, 12);
  });
});

describe('smoothAngle', () => {
  it('takes the short way round the wrap', () => {
    expect(smoothAngle(3.0, -3.0, 1)).toBeCloseTo(3.0 + (2 * Math.PI - 6.0), 9);
    expect(smoothAngle(0.1, 0.2, 0.5)).toBeCloseTo(0.15, 9);
  });
});

describe('DampedSpringScalar', () => {
  it('is exact for any step size (100 × 0.01 s == 1 × 1 s) for ζ < 1, = 1 and > 1', () => {
    for (const zeta of [0.3, 0.7, 1, 1.8]) {
      const a = new DampedSpringScalar(6, zeta); a.reset(1, -0.5);
      const b = new DampedSpringScalar(6, zeta); b.reset(1, -0.5);
      for (let i = 0; i < 100; i++) a.update(0.2, 0.01);
      b.update(0.2, 1.0);
      expect(a.x).toBeCloseTo(b.x, 9);
      expect(a.v).toBeCloseTo(b.v, 9);
    }
  });

  it('ζ = 0.7 overshoots a step by e^(−πζ/√(1−ζ²)) ≈ 4.6 %', () => {
    const s = new DampedSpringScalar(6, 0.7);
    let peak = 0;
    for (let i = 0; i < 600; i++) peak = Math.max(peak, s.update(1, 1 / 240));
    expect(peak - 1).toBeCloseTo(Math.exp((-Math.PI * 0.7) / Math.sqrt(1 - 0.49)), 3);
    expect(s.x).toBeCloseTo(1, 3);
  });

  it('matches SpringScalar when critically damped and does nothing for dt ≤ 0 or NaN', () => {
    const d = new DampedSpringScalar(5, 1); d.reset(2);
    const c = new SpringScalar(5); c.reset(2);
    for (let i = 0; i < 30; i++) { d.update(-1, 1 / 60); c.update(-1, 1 / 60); }
    expect(d.x).toBeCloseTo(c.x, 12);
    const x = d.x;
    d.update(5, 0); d.update(5, Number.NaN);
    expect(d.x).toBe(x);
  });
});

describe('coastStep', () => {
  it('covers r₀·τ in total at any frame rate', () => {
    const total = (hz: number) => {
      let r = 2, sum = 0;
      for (let i = 0; i < hz * 10; i++) { const s = coastStep(r, 1 / hz, 0.4); sum += s.distance; r = s.rate; }
      return sum;
    };
    expect(total(30)).toBeCloseTo(0.8, 9);
    expect(total(144)).toBeCloseTo(0.8, 9);
  });
});
