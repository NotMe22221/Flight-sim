import { describe, expect, it } from 'vitest';
import { FixedStepLoop, MAX_STEPS_PER_FRAME, PHYSICS_DT } from './loop';

describe('FixedStepLoop', () => {
  it('runs the right number of fixed steps and returns the remainder as alpha', () => {
    const loop = new FixedStepLoop();
    let n = 0;
    const r = loop.advance(PHYSICS_DT * 2.5, 1, () => {}, () => n++);
    expect(n).toBe(2);
    expect(r.steps).toBe(2);
    expect(r.alpha).toBeCloseTo(0.5, 9);
    const r2 = loop.advance(PHYSICS_DT * 0.6, 1, () => {}, () => n++);
    expect(n).toBe(3);
    expect(r2.alpha).toBeCloseTo(0.1, 6);
  });

  it('clamps huge frame deltas and caps steps', () => {
    const loop = new FixedStepLoop();
    let n = 0;
    const r = loop.advance(10, 1, () => {}, () => n++);
    expect(r.steps).toBeLessThanOrEqual(MAX_STEPS_PER_FRAME);
    expect(n).toBe(Math.min(Math.round(0.25 / PHYSICS_DT), MAX_STEPS_PER_FRAME));
  });

  it('time scale 0 runs no steps and reports alpha 1 (hold current state)', () => {
    const loop = new FixedStepLoop();
    let n = 0;
    const r = loop.advance(0.016, 0, () => {}, () => n++);
    expect(n).toBe(0);
    expect(r.alpha).toBe(1);
  });

  it('beforeStep runs before each step', () => {
    const loop = new FixedStepLoop();
    const order: string[] = [];
    loop.advance(PHYSICS_DT * 2, 1, () => order.push('b'), () => order.push('s'));
    expect(order).toEqual(['b', 's', 'b', 's']);
  });

  it('time scale 4 integrates 4× sim time', () => {
    const loop = new FixedStepLoop();
    let sim = 0;
    loop.advance(1 / 60, 4, () => {}, (dt) => { sim += dt; });
    expect(sim).toBeCloseTo(4 / 60, 2);
  });
});
