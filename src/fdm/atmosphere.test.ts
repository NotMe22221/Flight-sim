import { describe, expect, it } from 'vitest';
import { KT } from '../core/units';
import { atmosphere, casFromTas, easFromTas, iasFromCas, indicatedAltitude, tasFromCas } from './atmosphere';

describe('atmosphere', () => {
  it('ISA reference values', () => {
    const s0 = atmosphere(0);
    expect(s0.densityKgM3).toBeCloseTo(1.225, 3);
    expect(s0.speedOfSound).toBeCloseTo(340.3, 1);
    const s8 = atmosphere(2438);
    expect(Math.abs(s8.pressurePa - 75262)).toBeLessThan(50);
    expect(s8.densityKgM3).toBeCloseTo(0.9629, 3);
    expect(atmosphere(11000).temperatureK).toBeCloseTo(216.65, 2);
    expect(atmosphere(20000).pressurePa).toBeCloseTo(5475, -1);
  });

  it('temperature offset changes density but not pressure', () => {
    const hot = atmosphere(1000, 20), std = atmosphere(1000);
    expect(hot.pressurePa).toBeCloseTo(std.pressurePa, 6);
    expect(hot.densityKgM3).toBeLessThan(std.densityKgM3);
  });

  it('CAS ≈ EAS at low speed and round-trips with TAS', () => {
    const s = atmosphere(0);
    const cas = casFromTas(100 * KT, s.pressurePa, s.speedOfSound);
    expect(Math.abs(cas - easFromTas(100 * KT, s.densityKgM3)) / KT).toBeLessThan(1);
    const s3 = atmosphere(3000);
    const tas = tasFromCas(100 * KT, s3.pressurePa, s3.speedOfSound);
    expect(tas / KT).toBeGreaterThan(113);
    expect(casFromTas(tas, s3.pressurePa, s3.speedOfSound) / KT).toBeCloseTo(100, 6);
  });

  it('indicated altitude equals geometric altitude on a standard day with QNH set', () => {
    const s = atmosphere(1000);
    expect(indicatedAltitude(s.pressurePa, 101325)).toBeCloseTo(1000, 0);
    const low = atmosphere(1000, 0, 100300);
    expect(indicatedAltitude(low.pressurePa, 100300)).toBeCloseTo(1000, 0);
    // setting 1013 when the real QNH is 1003 over-reads by ≈ 85 m
    expect(indicatedAltitude(low.pressurePa, 101325) - 1000).toBeGreaterThan(75);
  });

  it('172S calibration: 53 KCAS reads ≈ 48 KIAS flaps up, 48 KCAS ≈ 41 KIAS flaps 30', () => {
    expect(iasFromCas(53 * KT, 0) / KT).toBeCloseTo(46.3, 0);
    expect(iasFromCas(56 * KT, 0) / KT).toBeCloseTo(50, 3);
    expect(iasFromCas(47 * KT, 30) / KT).toBeCloseTo(40, 3);
    expect(iasFromCas(0, 0)).toBe(0);
    expect(iasFromCas(170 * KT, 0) / KT).toBeCloseTo(174, 3);
  });
});
