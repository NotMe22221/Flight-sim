import { describe, expect, it } from 'vitest';
import { bearingDeg, destination, distanceM, trueToMagnetic, variationFromHeadings } from './geoMath';

const D2R = Math.PI / 180;

describe('geoMath', () => {
  it('bearing/destination round-trip', () => {
    const a = { lat: 37.6, lon: -122.4 };
    const b = destination(a, 75, 20_000);
    expect(distanceM(a, b)).toBeCloseTo(20_000, -1);
    expect(bearingDeg(a, b)).toBeCloseTo(75, 1);
  });
  it('variation from the true and magnetic headings (east positive, wraps)', () => {
    expect(variationFromHeadings(298 * D2R, 285 * D2R)).toBeCloseTo(13, 9); // KSFO: 13° E
    expect(variationFromHeadings(5 * D2R, 355 * D2R)).toBeCloseTo(10, 9); // across north
    expect(variationFromHeadings(355 * D2R, 2 * D2R)).toBeCloseTo(-7, 9); // west variation
    expect(variationFromHeadings(Number.NaN, 0)).toBe(0);
  });
  it('true → magnetic bearing (magnetic = true − east variation)', () => {
    expect(trueToMagnetic(298, 13)).toBeCloseTo(285, 9);
    expect(trueToMagnetic(5, 13)).toBeCloseTo(352, 9);
    expect(trueToMagnetic(350, -15)).toBeCloseTo(5, 9);
    expect(trueToMagnetic(90, Number.NaN)).toBe(90);
  });
});
