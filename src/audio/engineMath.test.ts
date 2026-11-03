import { describe, expect, it } from 'vitest';
import {
  airAbsorptionCutoffHz, bladePassHz, crankFrequencyHz, cycleFrequencyHz, dopplerRatio, engineCycleWave,
  engineLoudness, firingFrequencyHz, harmonicAmp, helicalTipMach, inverseDistanceGain, mapLoad, propToneLevel,
  propVortexHz, tipSpeedMs,
} from './engineMath';
import { fillPink, loopCrossfade, renderNoise } from './noise';
import { mulberry32 } from '../core/math';

describe('engine frequencies', () => {
  it('firing frequency: 2400 rpm, 4 cylinders, 4-stroke → 80 Hz', () => {
    expect(firingFrequencyHz(2400, 4)).toBeCloseTo(80, 9);
    expect(firingFrequencyHz(650, 4)).toBeCloseTo(21.667, 3);
    expect(firingFrequencyHz(2700, 6)).toBeCloseTo(135, 9);
    expect(firingFrequencyHz(-5, 4)).toBe(0);
  });
  it('crank and cycle orders', () => {
    expect(crankFrequencyHz(2400)).toBeCloseTo(40, 9);
    expect(cycleFrequencyHz(2400)).toBeCloseTo(20, 9);
    expect(firingFrequencyHz(2400, 4)).toBeCloseTo(4 * cycleFrequencyHz(2400), 9);
  });
  it('blade-pass: 2 blades @2400 rpm → 80 Hz; 3 blades @2000 → 100 Hz', () => {
    expect(bladePassHz(2400, 2)).toBeCloseTo(80, 9);
    expect(bladePassHz(2000, 3)).toBeCloseTo(100, 9);
  });
  it('tip speed / Mach match the §A2.1 table', () => {
    expect(tipSpeedMs(2400, 1.93)).toBeCloseTo(242.5, 0);
    expect(helicalTipMach(2700, 1.93, 0, 340)).toBeCloseTo(0.8, 2);
    expect(helicalTipMach(2400, 1.93, 50, 340)).toBeGreaterThan(helicalTipMach(2400, 1.93, 0, 340));
  });
  it('vortex noise sits in the 1.5–4 kHz band at cruise rpm', () => {
    const f = propVortexHz(2400, 1.93);
    expect(f).toBeGreaterThan(1500);
    expect(f).toBeLessThan(4000);
  });
});

describe('levels', () => {
  it('loudness is monotonic in MAP and clamped to [0, 1]', () => {
    for (const rpmFrac of [0, 0.24, 0.5, 0.9, 1, 1.4]) {
      let prev = -1;
      for (let map = 5; map <= 35; map += 0.5) {
        const l = engineLoudness(rpmFrac, mapLoad(map, 9, 28.5));
        expect(l).toBeGreaterThanOrEqual(prev);
        expect(l).toBeGreaterThanOrEqual(0);
        expect(l).toBeLessThanOrEqual(1);
        prev = l;
      }
    }
    expect(engineLoudness(1, 1)).toBeCloseTo(1, 9);
    expect(engineLoudness(5, 5)).toBe(1);
    expect(engineLoudness(Number.NaN, Number.NaN)).toBeGreaterThanOrEqual(0);
    expect(mapLoad(Number.NaN, 9, 28.5)).toBe(0);
  });
  it('loudness rises with rpm too', () => {
    expect(engineLoudness(0.9, 0.5)).toBeGreaterThan(engineLoudness(0.3, 0.5));
  });
  it('harmonic load law: duller at low load, table at 50 %', () => {
    expect(harmonicAmp(1, 1)).toBeCloseTo(1, 9);
    expect(harmonicAmp(4, 0) / harmonicAmp(1, 0)).toBeLessThan(harmonicAmp(4, 1) / harmonicAmp(1, 1));
    expect(harmonicAmp(2, 0.5) / harmonicAmp(1, 0.5)).toBeCloseTo(0.55 * Math.pow(2, -0.15), 6);
  });
  it('prop tone level grows with tip Mach and thrust, zero at low Mach', () => {
    expect(propToneLevel(0.2, 1)).toBe(0);
    expect(propToneLevel(0.7, 1)).toBeGreaterThan(propToneLevel(0.5, 1));
    expect(propToneLevel(0.7, 1)).toBeGreaterThan(propToneLevel(0.7, 0));
    expect(propToneLevel(2, 2)).toBeLessThanOrEqual(1);
  });
});

describe('engine cycle wave', () => {
  const mag = (w: { real: Float32Array; imag: Float32Array }, h: number) => Math.hypot(w.real[h], w.imag[h]);
  it('concentrates energy at multiples of the firing frequency', () => {
    const w = engineCycleWave({ cylinders: 4, load: 0.5 });
    expect(w.real.length).toBe(4 * 40 + 1);
    expect(w.real[0]).toBe(0);
    const firing = mag(w, 4);
    expect(mag(w, 8) / firing).toBeCloseTo(0.55 * Math.pow(2, -0.15), 1);
    // non-firing orders are weak but present (cylinder irregularity); crank order n=2 explicit
    expect(mag(w, 3) / firing).toBeLessThan(0.15);
    expect(mag(w, 3)).toBeGreaterThan(0);
    expect(mag(w, 2) / firing).toBeGreaterThan(0.15);
  });
  it('synthesizes (Web Audio PeriodicWave convention) to 4 pulses per cycle at the firing phases', () => {
    const w = engineCycleWave({ cylinders: 4, load: 1, crankOrder: 0 });
    const N = 1024, x = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / N;
      let v = 0;
      for (let h = 1; h < w.real.length; h++) v += w.real[h] * Math.cos(2 * Math.PI * h * t) + w.imag[h] * Math.sin(2 * Math.PI * h * t);
      x[i] = v;
    }
    const peak = Math.max(...x);
    const peaks: number[] = [];
    for (let i = 0; i < N; i++) {
      const prev = x[(i + N - 1) % N], next = x[(i + 1) % N];
      if (x[i] > 0.5 * peak && x[i] >= prev && x[i] > next) peaks.push(i / N);
    }
    expect(peaks.length).toBe(4);
    for (const p of peaks) { // circular distance to the nearest firing phase k/4 (timing jitter ±0.4 %)
      const d = Math.abs(p * 4 - Math.round(p * 4)) / 4;
      expect(d).toBeLessThan(0.006);
    }
  });

  it('is deterministic', () => {
    expect(engineCycleWave({ cylinders: 4, load: 0.3 }).imag).toEqual(engineCycleWave({ cylinders: 4, load: 0.3 }).imag);
  });
});

describe('Doppler and distance', () => {
  it('approaching source raises pitch, receding lowers it, co-moving is neutral', () => {
    const src = [0, 0, 0], lis = [1000, 0, 0], still = [0, 0, 0];
    expect(dopplerRatio(src, [60, 0, 0], lis, still, 340)).toBeCloseTo(340 / 280, 6);
    expect(dopplerRatio(src, [-60, 0, 0], lis, still, 340)).toBeCloseTo(340 / 400, 6);
    expect(dopplerRatio(src, [60, 0, 0], lis, [60, 0, 0], 340)).toBeCloseTo(1, 9);
    expect(dopplerRatio(src, [500, 0, 0], lis, still, 340)).toBe(2);
    expect(dopplerRatio(src, [60, 0, 0], src, still, 340)).toBe(1);
  });
  it('air absorption and inverse distance', () => {
    expect(airAbsorptionCutoffHz(50)).toBe(12000);
    expect(airAbsorptionCutoffHz(3000)).toBeLessThan(4000);
    expect(inverseDistanceGain(5)).toBe(1);
    expect(inverseDistanceGain(30)).toBeCloseTo(0.5, 9);
  });
});

describe('noise', () => {
  /** mean power of a naive DFT over a band of bins around f */
  const bandPower = (x: Float32Array, sr: number, f: number): number => {
    const n = x.length, k0 = Math.round((f * n) / sr);
    let p = 0;
    for (let k = k0 - 3; k <= k0 + 3; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) { const a = (2 * Math.PI * k * i) / n; re += x[i] * Math.cos(a); im -= x[i] * Math.sin(a); }
      p += re * re + im * im;
    }
    return p / 7;
  };
  it('pink noise falls ≈ 3 dB/octave between 200 Hz and 3.2 kHz', () => {
    const sr = 16000, n = 2048, rnd = mulberry32(9);
    const seg = new Float32Array(n);
    let lo = 0, hi = 0;
    for (let s = 0; s < 12; s++) { fillPink(seg, rnd); lo += bandPower(seg, sr, 200); hi += bandPower(seg, sr, 3200); }
    const slopeDb = (10 * Math.log10(hi / lo)) / 4; // 4 octaves
    expect(slopeDb).toBeGreaterThan(-4.5);
    expect(slopeDb).toBeLessThan(-1.5);
  });
  it('loop crossfade makes the seam continuous', () => {
    const src = Float32Array.from({ length: 110 }, (_, i) => i);
    const out = loopCrossfade(src, new Float32Array(100), 10);
    expect(out[0]).toBeCloseTo(src[100], 6); // continues the tail
    expect(out[50]).toBe(50);
  });
  it('renders the requested length, bounded', () => {
    const x = renderNoise('white', 8000, 0.5);
    expect(x.length).toBe(4000);
    expect(Math.max(...x.map(Math.abs))).toBeLessThanOrEqual(1.5);
  });
});
