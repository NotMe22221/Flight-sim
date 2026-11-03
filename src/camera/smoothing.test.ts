import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SpringScalar, SpringVector3, expSmoothing, omegaFromTau, smoothAngle } from './smoothing';

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
