import { describe, expect, it } from 'vitest';
import { componentScale, landingBand, landingComponents, landingExtras, landingRunway, scoreBand } from './landingReportModel';
import { defaultUnitsSettings } from './settingsStore';

const units = defaultUnitsSettings();
const metric = { ...units, altitude: 'm' as const, speed: 'kmh' as const };

/** Exactly what src/activities/TouchdownDetector.ts emits (percent components + raw measurements). */
const real = {
  grade: 'Great', runway: 'KSFO 28R', verticalSpeedFpm: -120, peakG: 1.42, centrelineOffsetM: -2.5,
  touchdownFromThresholdM: 340, stopDistanceM: 610, crabDeg: 1.3, bounces: 0,
  centre: 92, smooth: 89, zone: 88, stop: 81,
};

const fracOf = (d: Record<string, number | string>, score?: number) => Object.fromEntries(landingComponents(d, units, score).map((c) => [c.key, c.frac]));

describe('landingComponents', () => {
  it('reads the real scorer payload: 0..100 percentages and its raw keys', () => {
    const c = landingComponents(real, units, 8781);
    expect(c.map((x) => x.key)).toEqual(['center', 'smooth', 'zone', 'stop']);
    expect(c.map((x) => x.frac)).toEqual([0.92, 0.89, 0.88, 0.81]);
    expect(c[0].raw).toBe('L 8 ft'); // 2.5 m left of the centreline
    expect(c[1].raw).toContain('120');
    expect(c[2].raw).toContain('past threshold');
    expect(c[3].raw).toContain('ft');
    expect(c.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 9);
  });
  it('uses the user units for the raw measurements', () => {
    const c = landingComponents(real, metric, 8781);
    expect(c[0].raw).toBe('L 3 m');
    expect(c[3].raw).toBe('610 m');
  });
  it('shows a touch-and-go as zero stopping score', () => {
    const c = landingComponents({ ...real, stop: 0, stopDistanceM: 'touch-and-go' }, units, 7000);
    expect(c[3].frac).toBe(0);
    expect(c[3].raw).toBe('touch-and-go');
  });
  it('accepts 0..1 fractions from other scorers', () => {
    expect(fracOf({ center: 0.5, smooth: 1, zone: 0.25, stop: 0 }, 5375)).toEqual({ center: 0.5, smooth: 1, zone: 0.25, stop: 0 });
  });
  it('derives components from raw measurements when no normalised values are sent', () => {
    const f = fracOf({ centrelineOffsetM: 0, verticalSpeedFpm: -60, touchdownFromThresholdM: 305, stopDistanceM: 500, runwayLengthM: 1305 });
    expect(f.center).toBe(1);
    expect(f.smooth).toBe(1);
    expect(f.zone).toBe(1);
    expect(f.stop).toBeCloseTo(0.5, 9);
    expect(fracOf({}).center).toBeNull();
  });
});

describe('componentScale', () => {
  it('percent when any value exceeds 1', () => expect(componentScale([92, 0.5, null, 1])).toBe(100));
  it('fractions by default', () => expect(componentScale([0.9, 0.8, 0.7, 0.6])).toBe(1));
  it('tiny percentages are told apart from fractions by the score', () => {
    // 1 % everywhere scores ~100, while fractions of 1 would score 10 000
    expect(componentScale([1, 1, 1, 1], 100)).toBe(100);
    expect(componentScale([1, 1, 1, 1], 10000)).toBe(1);
  });
});

describe('band, extras, runway', () => {
  it('prefers the scorer grade, else the score band', () => {
    expect(landingBand(real, 8781)).toBe('Great landing');
    expect(landingBand({ grade: 'Butter' }, 9500)).toBe('Butter');
    expect(landingBand({}, 9500)).toBe(scoreBand(9500));
    expect(scoreBand(0)).toBe('Crash');
  });
  it('labels the known extras and humanizes unknown keys; consumed keys are not repeated', () => {
    const x = landingExtras({ ...real, flareTimeS: 2.25 });
    expect(x).toEqual([
      { label: 'Peak load', value: '1.42 g' },
      { label: 'Crab at touchdown', value: '1.3°' },
      { label: 'Bounces', value: '0' },
      { label: 'Flare time s', value: '2.25' },
    ]);
  });
  it('title runway', () => {
    expect(landingRunway(real)).toBe('KSFO 28R');
    expect(landingRunway({ airport: 'KSFO' })).toBe('KSFO');
    expect(landingRunway({})).toBe('');
  });
});
