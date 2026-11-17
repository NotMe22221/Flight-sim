import { describe, expect, it } from 'vitest';
import { seasonFor } from './season';

const at = (m: number, d: number) => Date.UTC(2026, m - 1, d, 12);

describe('seasonFor', () => {
  it('northern temperate: autumn in mid-October, dormant in January, nothing in summer', () => {
    expect(seasonFor(at(10, 17), 47).autumn).toBe(1);
    expect(seasonFor(at(10, 17), 47).dormant).toBe(0);
    expect(seasonFor(at(1, 15), 47).dormant).toBe(1);
    expect(seasonFor(at(1, 15), 47).autumn).toBe(0);
    expect(seasonFor(at(7, 1), 47)).toEqual({ autumn: 0, dormant: 0 });
    expect(seasonFor(at(9, 1), 47).autumn).toBe(0); // early September still green
  });

  it('southern hemisphere is half a year off; the tropics and the poles do not change', () => {
    expect(seasonFor(at(4, 17), -42).autumn).toBeGreaterThan(0.9);
    expect(seasonFor(at(7, 15), -42).dormant).toBeGreaterThan(0.9);
    expect(seasonFor(at(10, 17), -42).autumn).toBe(0);
    expect(seasonFor(at(10, 17), 10)).toEqual({ autumn: 0, dormant: 0 });
    expect(seasonFor(at(1, 15), 78)).toEqual({ autumn: 0, dormant: 0 });
  });

  it('wraps across the new year and stays in 0…1', () => {
    expect(seasonFor(at(12, 20), 50).dormant).toBeGreaterThan(0.8);
    for (let m = 1; m <= 12; m++) for (const lat of [-60, -35, 0, 35, 60]) {
      const s = seasonFor(at(m, 1), lat);
      expect(s.autumn).toBeGreaterThanOrEqual(0); expect(s.autumn).toBeLessThanOrEqual(1);
      expect(s.dormant).toBeGreaterThanOrEqual(0); expect(s.dormant).toBeLessThanOrEqual(1);
    }
  });
});
