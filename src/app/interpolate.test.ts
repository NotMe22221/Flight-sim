import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import { interpolateState } from './interpolate';

describe('interpolateState', () => {
  it('interpolates the pose without aliasing or reallocating the output arrays', () => {
    const prev = makeAircraftState({ posNED: [0, 0, -100], euler: [0, 0, 3.1] });
    const cur = makeAircraftState({ posNED: [10, 20, -110], euler: [0.2, 0.1, -3.1] });
    const out = structuredClone(cur);
    const pos = out.posNED, q = out.qNB;
    interpolateState(prev, cur, 0.5, out);
    expect(out.posNED).toBe(pos);
    expect(out.qNB).toBe(q);
    expect(out.posNED).toEqual([5, 10, -105]);
    expect(Math.abs(out.euler[2])).toBeGreaterThan(3.1); // shortest arc across ±π
    out.posNED[0] = 999;
    expect(cur.posNED[0]).toBe(10);
    interpolateState(prev, cur, 1, out);
    expect(out.posNED).toBe(pos);
    expect(out.posNED[0]).toBe(10);
  });
});
