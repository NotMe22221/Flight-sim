import { describe, expect, it } from 'vitest';
import type { Vec3, WindLayer } from '../core/types';
import { KT } from '../core/units';
import { GustModel, LOG_PROFILE_MAX, gustEnvelope, gustExcessAt, logProfileFactor, windAt, windVectorNED } from './wind';

const layer = (altM: number, directionDeg: number, speedKt: number, gustKt = 0): WindLayer => ({ altM, directionDeg, speedKt, gustKt });

describe('wind', () => {
  it('FROM direction → velocity sign: wind from 270° at 10 kt moves air toward the east (+E ≈ 5.14 m/s)', () => {
    const v = windVectorNED(270, 10 * KT);
    expect(v[0]).toBeCloseTo(0, 6);
    expect(v[1]).toBeCloseTo(5.144, 2);
    expect(v[2]).toBe(0);
    // from north → moves south (−N)
    const n = windVectorNED(0, 10);
    expect(n[0]).toBeCloseTo(-10, 6);
    expect(n[1]).toBeCloseTo(0, 6);
    // via windAt at the reference height
    const w = windAt([layer(10, 270, 10)], 10, 10);
    expect(w[1]).toBeCloseTo(5.144, 2);
  });

  it('log profile: 1.0 at the 10 m reference, < 1 below, capped at 1.3× above', () => {
    expect(logProfileFactor(10)).toBeCloseTo(1, 9);
    expect(logProfileFactor(2)).toBeLessThan(1);
    expect(logProfileFactor(2)).toBeGreaterThan(0);
    expect(logProfileFactor(0)).toBeGreaterThanOrEqual(0);
    expect(logProfileFactor(1000)).toBe(LOG_PROFILE_MAX);
    for (const h of [1, 5, 10, 30, 100, 1000]) expect(logProfileFactor(h)).toBeLessThanOrEqual(LOG_PROFILE_MAX);
    // monotonic
    let prev = 0;
    for (let h = 0.1; h < 200; h *= 1.5) { const f = logProfileFactor(h); expect(f).toBeGreaterThanOrEqual(prev); prev = f; }
    const single = windAt([layer(10, 270, 10)], 500, 500);
    expect(Math.hypot(single[0], single[1])).toBeCloseTo(10 * KT * LOG_PROFILE_MAX, 6);
  });

  it('interpolates vectorially between layers (direction wraps through north)', () => {
    const layers = [layer(10, 350, 10), layer(1010, 10, 10)];
    const mid = windAt(layers, 510, 500);
    // bisector of 350°/010° is 000° "from north" → velocity toward south (−N), ~zero east
    expect(mid[1]).toBeCloseTo(0, 6);
    expect(mid[0]).toBeLessThan(0);
    expect(Math.abs(mid[0])).toBeCloseTo(10 * KT * Math.cos((10 * Math.PI) / 180), 6);
    // at the layer altitudes the layer values are returned exactly
    const lo = windAt(layers, 10, 10), hi = windAt(layers, 1010, 1000);
    expect(lo).toEqual(windVectorNED(350, 10 * KT));
    expect(hi).toEqual(windVectorNED(10, 10 * KT));
    // above the top: held
    expect(windAt(layers, 5000, 5000)).toEqual(windVectorNED(10, 10 * KT));
    // speed interpolation with equal directions
    const sp = windAt([layer(10, 90, 10), layer(2010, 90, 30)], 1010, 1000);
    expect(Math.hypot(sp[0], sp[1])).toBeCloseTo(20 * KT, 6);
  });

  it('empty layers → calm; gust excess interpolates and is never negative', () => {
    const out: Vec3 = [1, 1, 1];
    expect(windAt([], 100, 100, out)).toEqual([0, 0, 0]);
    expect(gustExcessAt([layer(10, 270, 10, 20)], 10)).toBeCloseTo(10 * KT, 6);
    expect(gustExcessAt([layer(10, 270, 10, 5)], 10)).toBe(0);
    expect(gustExcessAt([layer(10, 270, 10, 20), layer(1010, 270, 10, 0)], 510)).toBeCloseTo(5 * KT, 6);
  });

  it('1 − cosine gust envelope: 0 at the ends, 1 at the ramp length, symmetric', () => {
    expect(gustEnvelope(0, 60)).toBe(0);
    expect(gustEnvelope(60, 60)).toBeCloseTo(1, 9);
    expect(gustEnvelope(120, 60)).toBe(0);
    expect(gustEnvelope(30, 60)).toBeCloseTo(0.5, 9);
    expect(gustEnvelope(90, 60)).toBeCloseTo(0.5, 9);
    expect(gustEnvelope(-1, 60)).toBe(0);
    expect(gustEnvelope(200, 60)).toBe(0);
  });

  it('GustModel: deterministic, triggers only with gust excess, bump along the mean wind, never exceeds the excess', () => {
    const mean = windVectorNED(270, 10 * KT);
    const run = (seed: number, excess: number) => {
      const g = new GustModel(seed, { meanIntervalS: 5, minIntervalS: 1 });
      let peak = 0, triggered = 0, wasActive = false;
      const v: Vec3 = [0, 0, 0];
      for (let i = 0; i < 120 * 120; i++) {
        g.update(1 / 120, 30, excess, mean);
        g.gustNED(v);
        expect(v[0]).toBeCloseTo(0, 9); // along +E only
        expect(v[1]).toBeGreaterThanOrEqual(0);
        peak = Math.max(peak, v[1]);
        if (g.active && !wasActive) triggered++;
        wasActive = g.active;
      }
      return { peak, triggered };
    };
    const a = run(42, 5), b = run(42, 5), c = run(43, 5);
    expect(a).toEqual(b); // deterministic
    expect(a.triggered).toBeGreaterThan(3);
    expect(a.peak).toBeGreaterThan(2);
    expect(a.peak).toBeLessThanOrEqual(5 + 1e-9);
    expect(c.triggered !== a.triggered || c.peak !== a.peak).toBe(true);
    expect(run(42, 0)).toEqual({ peak: 0, triggered: 0 }); // no excess → no gusts
  });

  it('GustModel.trigger produces a full 1 − cosine bump over 2 × ramp distance', () => {
    const g = new GustModel(1, { magMin: 1, magMax: 1, rampMinM: 60, rampMaxM: 60 });
    g.trigger(4);
    const v: Vec3 = [0, 0, 0];
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) { g.update(0.1, 20, 4, [1, 0, 0]); samples.push(g.gustNED(v)[0]); }
    // 120 m at 20 m/s = 6 s = 60 samples; peak near sample 30
    const peakI = samples.indexOf(Math.max(...samples));
    expect(Math.abs(peakI - 29)).toBeLessThanOrEqual(1);
    expect(Math.max(...samples)).toBeCloseTo(4, 2);
    expect(samples[70]).toBe(0);
    expect(g.active).toBe(false);
  });
});
