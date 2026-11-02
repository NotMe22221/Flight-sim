import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../core/types';
import { SimEnvironment } from './environment';

describe('SimEnvironment', () => {
  it('falls back to the spawn elevation before terrain loads, then to the last good height', () => {
    let data: number | null = null;
    const env = new SimEnvironment({ lat0: 0, lon0: 0, alt0: 0 }, { groundHeight: () => data });
    env.fallbackGroundUp = 4;
    expect(env.groundHeight(0, 0)).toBe(4);
    data = 12.5;
    expect(env.groundHeight(0, 0)).toBe(12.5);
    data = null;
    expect(env.groundHeight(0, 0)).toBe(12.5);
    data = NaN;
    expect(env.groundHeight(0, 0)).toBe(12.5);
  });

  it('default normal is up (NED −D) and default wind is calm', () => {
    const env = new SimEnvironment({ lat0: 0, lon0: 0, alt0: 0 }, { groundHeight: () => 0 });
    const n: Vec3 = [1, 1, 1];
    expect(env.groundNormal(0, 0, n)).toEqual([0, 0, -1]);
    const w: Vec3 = [9, 9, 9];
    expect(env.windNED(0, 0, 0, w)).toEqual([0, 0, 0]);
  });

  it('delegates wind and normal when provided', () => {
    const env = new SimEnvironment({ lat0: 0, lon0: 0, alt0: 0 }, {
      groundHeight: () => 0,
      windNED: (_n, _e, _d, out) => { out[0] = 1; out[1] = 2; out[2] = 0; return out; },
      groundNormal: (_n, _e, out) => { out[0] = 0.1; out[1] = 0; out[2] = -0.995; return out; },
    });
    expect(env.windNED(0, 0, 0, [0, 0, 0])).toEqual([1, 2, 0]);
    expect(env.groundNormal(0, 0, [0, 0, 0])[2]).toBeCloseTo(-0.995);
  });
});
