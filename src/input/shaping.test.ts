import { describe, expect, it } from 'vitest';
import { makeShaping, shapeAxis, shapeStick, shapingFromSensitivity, unipolarFromRaw } from './shaping';

const grid = (n = 401): number[] => Array.from({ length: n }, (_, i) => -1 + (2 * i) / (n - 1));

describe('shapeAxis (deadzone, saturation, curve)', () => {
  const variants = [
    makeShaping({ deadzone: 0.05, curve: 0 }),
    makeShaping({ deadzone: 0.12, curve: 0.3 }),
    makeShaping({ deadzone: 0.04, curve: 1, saturation: 0.9 }),
    makeShaping({ deadzone: 0.1, curve: 0.5, gain: 1.5 }),
  ];

  it('is monotonic non-decreasing and odd-symmetric', () => {
    for (const s of variants) {
      let prev = -Infinity;
      for (const x of grid()) {
        const y = shapeAxis(x, s);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-12);
        expect(shapeAxis(-x, s)).toBeCloseTo(-y, 12);
        prev = y;
      }
    }
  });

  it('reads 0 inside the deadzone, starts from 0 at its edge, full at saturation', () => {
    const s = makeShaping({ deadzone: 0.12, curve: 0.3 });
    expect(shapeAxis(0.11, s)).toBe(0);
    expect(shapeAxis(-0.12, s)).toBe(0);
    expect(shapeAxis(0.1201, s)).toBeLessThan(0.001);
    expect(shapeAxis(0.98, s)).toBe(1);
    expect(shapeAxis(1, s)).toBe(1);
    expect(shapeAxis(-1, s)).toBe(-1);
    expect(Object.is(shapeAxis(-0.05, s), 0)).toBe(true); // no negative zero
  });

  it('curve gives finer control near centre, invert flips, NaN reads 0', () => {
    const lin = makeShaping({ deadzone: 0, saturation: 1, curve: 0 });
    const cub = makeShaping({ deadzone: 0, saturation: 1, curve: 1 });
    expect(shapeAxis(0.5, lin)).toBeCloseTo(0.5, 12);
    expect(shapeAxis(0.5, cub)).toBeCloseTo(0.125, 12);
    expect(shapeAxis(0.5, makeShaping({ deadzone: 0, saturation: 1, invert: true }))).toBeCloseTo(-0.5, 12);
    expect(shapeAxis(Number.NaN, lin)).toBe(0);
  });

  it('sensitivity slider maps to curve (negative) and gain (positive)', () => {
    expect(shapingFromSensitivity(-60).curve).toBeCloseTo(0.6, 12);
    expect(shapingFromSensitivity(100).gain).toBeCloseTo(1.5, 12);
    expect(shapingFromSensitivity(0).curve).toBe(0);
  });
});

describe('shapeStick (radial deadzone)', () => {
  it('has no square-corner snap and keeps direction', () => {
    const s = makeShaping({ deadzone: 0.2, curve: 0 });
    const out: [number, number] = [0, 0];
    shapeStick(0.15, 0.15, s, out); // |v| = 0.21 > 0.2: just outside a radial deadzone
    expect(out[0]).toBeGreaterThan(0);
    expect(out[0]).toBeCloseTo(out[1], 12);
    shapeStick(0.1, 0.1, s, out);
    expect(out).toEqual([0, 0]);
    shapeStick(0, -1, s, out);
    expect(out[1]).toBe(-1);
  });
});

describe('unipolar throttle mapping', () => {
  it('inverted slider: full forward (−1) = full throttle, back (+1) = idle', () => {
    expect(unipolarFromRaw(-1, true)).toBe(1);
    expect(unipolarFromRaw(1, true)).toBe(0);
    expect(unipolarFromRaw(0, true)).toBeCloseTo(0.5, 12);
    expect(unipolarFromRaw(-0.95, true)).toBe(1); // inside the 3 % end deadzone
  });

  it('non-inverted slider: +1 = full, −1 = idle; monotonic both ways', () => {
    expect(unipolarFromRaw(1, false)).toBe(1);
    expect(unipolarFromRaw(-1, false)).toBe(0);
    let pi = Infinity, pn = -Infinity;
    for (const x of grid()) {
      const i = unipolarFromRaw(x, true), n = unipolarFromRaw(x, false);
      expect(i).toBeLessThanOrEqual(pi + 1e-12);
      expect(n).toBeGreaterThanOrEqual(pn - 1e-12);
      expect(i + n).toBeCloseTo(1, 12);
      pi = i; pn = n;
    }
  });
});
