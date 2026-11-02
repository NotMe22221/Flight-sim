import { describe, expect, it } from 'vitest';
import { Table1D, Table2D, deltaDeg, eulerFromQ, qConj, qFromEuler, qMul, qRotate, qSlerp, wrapPi } from './math';

describe('math', () => {
  it('quaternion from Euler rotates body x into NED correctly', () => {
    // Pitch up 30°, heading 90° (east): body x axis points east and up.
    const qbn = qFromEuler(0, Math.PI / 6, Math.PI / 2);
    const x = qRotate(qbn, [1, 0, 0]);
    expect(x[0]).toBeCloseTo(0, 10); // north
    expect(x[1]).toBeCloseTo(Math.cos(Math.PI / 6), 10); // east
    expect(x[2]).toBeCloseTo(-Math.sin(Math.PI / 6), 10); // down (negative = up)
    const e = eulerFromQ(qbn);
    expect(e[0]).toBeCloseTo(0, 10);
    expect(e[1]).toBeCloseTo(Math.PI / 6, 10);
    expect(e[2]).toBeCloseTo(Math.PI / 2, 10);
  });

  it('roll right 45° tilts body y (right wing) down', () => {
    const qbn = qFromEuler(Math.PI / 4, 0, 0);
    const y = qRotate(qbn, [0, 1, 0]);
    expect(y[1]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(y[2]).toBeCloseTo(Math.SQRT1_2, 10); // down positive → wing down
  });

  it('conjugate inverts rotation', () => {
    const q = qFromEuler(0.3, -0.2, 1.1);
    const v: [number, number, number] = [1, 2, 3];
    const w = qRotate(qConj(q), qRotate(q, v));
    expect(w[0]).toBeCloseTo(1, 10); expect(w[1]).toBeCloseTo(2, 10); expect(w[2]).toBeCloseTo(3, 10);
    const id = qMul(q, qConj(q));
    expect(id[0]).toBeCloseTo(1, 10); expect(Math.abs(id[1]) + Math.abs(id[2]) + Math.abs(id[3])).toBeLessThan(1e-10);
  });

  it('slerp halfway between identity and 90° yaw is 45°', () => {
    const a = qFromEuler(0, 0, 0), b = qFromEuler(0, 0, Math.PI / 2);
    const m = qSlerp(a, b, 0.5);
    expect(eulerFromQ(m)[2]).toBeCloseTo(Math.PI / 4, 10);
  });

  it('angle helpers', () => {
    expect(Math.abs(wrapPi(3 * Math.PI))).toBeCloseTo(Math.PI, 10);
    expect(wrapPi(0.5)).toBeCloseTo(0.5, 12);
    expect(wrapPi(-Math.PI - 0.1)).toBeCloseTo(Math.PI - 0.1, 10);
    expect(deltaDeg(10, 350)).toBe(20);
    expect(deltaDeg(350, 10)).toBe(-20);
  });

  it('tables interpolate and clamp', () => {
    const t = new Table1D([0, 1, 2], [0, 10, 40]);
    expect(t.at(0.5)).toBe(5);
    expect(t.at(1.5)).toBe(25);
    expect(t.at(-1)).toBe(0);
    expect(t.at(5)).toBe(40);
    const t2 = new Table2D([0, 1], [0, 10], [0, 1, 2, 3]);
    expect(t2.at(0.5, 5)).toBeCloseTo(1.5, 10);
    expect(t2.at(1, 10)).toBe(3);
    expect(t2.at(-1, 20)).toBe(1);
  });
});
