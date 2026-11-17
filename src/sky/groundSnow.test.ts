import { describe, expect, it } from 'vitest';
import { GroundSnowState, groundSnowFor, snowAt } from './groundSnow';

const w = (temperatureC: number, snowing = false) => ({ temperatureC, precipitationType: snowing ? 'snow' as const : 'none' as const, precipitationRate: snowing ? 2 : 0 });

describe('groundSnowFor', () => {
  it('auto: the snow line follows the temperature', () => {
    expect(groundSnowFor(w(18), 'auto').lineM).toBeGreaterThan(2700);
    expect(groundSnowFor(w(18), 'auto').lineM).toBeLessThan(3100);
    const mild = groundSnowFor(w(5), 'auto').lineM;
    expect(mild).toBeGreaterThan(800); expect(mild).toBeLessThan(1100);
    expect(snowAt(groundSnowFor(w(-3), 'auto'), 0)).toBe(1); // a freezing day: white at sea level
    expect(snowAt(groundSnowFor(w(18), 'auto'), 500)).toBe(0); // summer lowlands bare
  });

  it('falling snow whitens the ground; overrides win', () => {
    expect(snowAt(groundSnowFor(w(1, true), 'auto'), 0)).toBe(1);
    expect(snowAt(groundSnowFor(w(-10), 'none'), 3000)).toBe(0);
    expect(snowAt(groundSnowFor(w(30), 'full'), 0)).toBe(1);
  });

  it('snowAt blends over ±150 m around the line', () => {
    const s = { lineM: 1000, amount: 1 };
    expect(snowAt(s, 800)).toBe(0); expect(snowAt(s, 1000)).toBeCloseTo(0.5); expect(snowAt(s, 1200)).toBe(1);
  });
});

describe('GroundSnowState', () => {
  it('eases toward the target, snaps on request', () => {
    const s = new GroundSnowState(40, 0.1);
    s.update({ lineM: -500, amount: 1 }, 1);
    expect(s.amount).toBeCloseTo(0.1); expect(s.lineM).toBe(8960);
    s.update({ lineM: -500, amount: 1 }, 0, true);
    expect(s.lineM).toBe(-500); expect(s.amount).toBe(1);
  });
});
