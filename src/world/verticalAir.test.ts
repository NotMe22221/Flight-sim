import { describe, expect, it } from 'vitest';
import { VerticalAir } from './verticalAir';

/** a ridge running east-west at north = 0: rises 300 m over 1 km from the south (slope 0.3) */
const ridge = (n: number) => (n < -1000 ? 0 : n > 0 ? Math.max(0, 300 - 0.3 * n) : 300 + 0.3 * n);

describe('VerticalAir', () => {
  it('ridge lift on the windward slope, sink in the lee, fading with height', () => {
    const v = new VerticalAir((n) => ridge(n));
    v.setFrame(45, 7);
    // wind from the south (blowing north at 10 m/s)
    const windward = v.upwardMs(-500, 0, -(150 + 50), 10, 0); // 50 m above the south slope
    const lee = v.upwardMs(500, 0, -(150 + 50), 10, 0);
    const high = v.upwardMs(-500, 0, -(150 + 1000), 10, 0);
    expect(windward).toBeCloseTo(3 * Math.exp(-50 / 250), 1);
    expect(lee).toBeLessThan(-2);
    expect(high).toBeLessThan(0.1);
    expect(v.upwardMs(-500, 0, -(150 + 50), 0, 0)).toBe(0); // calm: nothing
    expect(v.upwardMs(-5000, 0, -100, 10, 0)).toBe(0); // flat ground
  });

  it('thermals: columns of lift with sink between, none above the top or at night, drifting with the wind', () => {
    const v = new VerticalAir(() => 0);
    v.setFrame(40, -100);
    v.setConvection(1, 1500);
    let max = -Infinity, min = Infinity, sum = 0, cnt = 0;
    for (let n = 0; n < 8000; n += 50) for (let e = 0; e < 8000; e += 50) {
      const w = v.upwardMs(n, e, -800, 0, 0);
      max = Math.max(max, w); min = Math.min(min, w); sum += w; cnt++;
    }
    expect(max).toBeGreaterThan(1.2); expect(max).toBeLessThan(3.6);
    expect(min).toBeGreaterThan(-0.4);
    expect(sum / cnt).toBeLessThan(0.1); // mostly gentle sink between narrow thermals
    expect(v.upwardMs(1000, 1000, -1600, 0, 0)).toBe(0); // above the top
    v.setConvection(0, 1500);
    expect(v.upwardMs(1000, 1000, -800, 0, 0)).toBe(0);
    // drift: the field moves 600 m east in a minute of 10 m/s westerly wind
    v.setConvection(1, 1500);
    const at = (e: number) => v.thermal(2000, e, 800);
    const before = [0, 100, 200, 300].map(at);
    for (let i = 0; i < 600; i++) v.update(0.1, 0, 10);
    const after = [600, 700, 800, 900].map(at);
    for (let i = 0; i < 4; i++) expect(Math.abs(after[i] - before[i])).toBeLessThan(0.15); // only the slow life cycle differs
  });

  it('the thermal field stays put across a floating-origin shift', () => {
    const a = new VerticalAir(() => 0), b = new VerticalAir(() => 0);
    a.setConvection(1, 1500); b.setConvection(1, 1500);
    a.setFrame(40, -100);
    const dLat = 3000 / 6_371_000 * 180 / Math.PI; // origin moved 3 km north
    b.setFrame(40 + dLat, -100);
    for (const [n, e] of [[3500, 200], [4100, 900], [5000, 1500]]) expect(b.thermal(n - 3000, e, 700)).toBeCloseTo(a.thermal(n, e, 700), 2);
  });
});

import { convectionFor } from '../app/Simulator';
describe('convectionFor', () => {
  const D = Math.PI / 180;
  const cu = { baseM: 1200, topM: 2500, coverage: 0.3, density: 0.6, type: 'cumulus' as const };
  it('a sunny warm day convects up to the cumulus base; night, rain, overcast do not', () => {
    const day = convectionFor({ clouds: [cu], precipitationRate: 0, temperatureC: 25 }, 60 * D, 200);
    expect(day.strength).toBeGreaterThan(0.95); expect(day.topAglM).toBe(1000);
    expect(convectionFor({ clouds: [], precipitationRate: 0, temperatureC: 25 }, -5 * D, 0).strength).toBe(0);
    expect(convectionFor({ clouds: [], precipitationRate: 3, temperatureC: 25 }, 60 * D, 0).strength).toBe(0);
    expect(convectionFor({ clouds: [{ ...cu, type: 'stratus', coverage: 1 }], precipitationRate: 0, temperatureC: 25 }, 60 * D, 0).strength).toBeLessThan(0.15);
    expect(convectionFor({ clouds: [], precipitationRate: 0, temperatureC: 25 }, 60 * D, 0, 1).strength).toBeLessThan(0.35);
  });
});
