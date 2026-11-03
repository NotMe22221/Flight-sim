import { describe, expect, it } from 'vitest';
import { HoldTracker, KeyAxis, type HoldSpec } from './keyAxis';

const DT = 1 / 60;

/** Number of frames until `cond` holds, or -1. */
function framesUntil(axis: KeyAxis, cond: (v: number) => boolean, max = 600): number {
  for (let i = 1; i <= max; i++) { if (cond(axis.step(DT))) return i; }
  return -1;
}

describe('KeyAxis ramps', () => {
  it('reaches full deflection in 0.6 s ± one frame', () => {
    const a = new KeyAxis();
    a.setDirection(1);
    const n = framesUntil(a, (v) => v === 1);
    expect(Math.abs(n * DT - 0.6)).toBeLessThanOrEqual(DT + 1e-9);
    // not full one frame earlier
    const b = new KeyAxis();
    b.setDirection(1);
    for (let i = 0; i < n - 1; i++) b.step(DT);
    expect(b.value).toBeLessThan(1);
  });

  it('auto-centres from full in 0.3 s ± one frame', () => {
    const a = new KeyAxis();
    a.set(-1);
    a.setDirection(0);
    const n = framesUntil(a, (v) => v === 0);
    expect(Math.abs(n * DT - 0.3)).toBeLessThanOrEqual(DT + 1e-9);
  });

  it('works with other frame rates (144 Hz, 30 Hz)', () => {
    for (const dt of [1 / 144, 1 / 30]) {
      const a = new KeyAxis();
      a.setDirection(-1);
      let t = 0;
      while (a.value > -1) { a.step(dt); t += dt; }
      expect(Math.abs(t - 0.6)).toBeLessThanOrEqual(dt + 1e-9);
    }
  });

  it('reversal goes through centre at the centring rate first', () => {
    const a = new KeyAxis();
    a.set(1);
    a.setDirection(-1);
    a.step(0.3); // 0.3 s at the centring rate covers exactly 1.0
    expect(a.value).toBeCloseTo(0, 6);
    a.step(0.3);
    expect(a.value).toBeCloseTo(-0.5, 6);
  });

  it('sticky mode holds the value, sensitivity scales the ramp', () => {
    const a = new KeyAxis({ rampTime: 0.6, centreTime: 0.3, tapStep: 0, autoCentre: false, min: -1, max: 1 });
    a.setDirection(1);
    a.step(0.3);
    a.setDirection(0);
    a.step(1);
    expect(a.value).toBeCloseTo(0.5, 6);
    const b = new KeyAxis();
    b.sensitivity = 2;
    b.setDirection(1);
    b.step(0.15);
    expect(b.value).toBeCloseTo(0.5, 6);
  });
});

describe('HoldTracker repeat timing', () => {
  const knob: HoldSpec = { repeat: 'knob', held: false };
  const step: HoldSpec = { repeat: 'step', held: false };
  const none: HoldSpec = { repeat: 'none', held: true };
  const specOf = (a: string): HoldSpec => (a === 'trim' ? knob : a === 'thr' ? step : none);

  function run(tracker: HoldTracker<string>, seconds: number, dt: number): number[] {
    const times: number[] = [];
    let t = 0;
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) {
      t += dt;
      tracker.poll(dt, () => times.push(t), () => undefined);
    }
    return times;
  }

  it('fires once on press, then 10 Hz after 300 ms', () => {
    const tr = new HoldTracker<string>(specOf);
    tr.press('thr');
    const times = run(tr, 0.95, 0.01);
    // edge on the first poll, then repeats at 0.3, 0.4, ... 0.9 s of hold time
    expect(times.length).toBe(1 + 7);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(0.3 - 1e-6);
    expect(times[1] - times[0]).toBeLessThanOrEqual(0.31 + 1e-6);
    for (let i = 2; i < times.length; i++) expect(times[i] - times[i - 1]).toBeCloseTo(0.1, 6);
  });

  it('knob actions accelerate to 20 Hz after 1 s', () => {
    const tr = new HoldTracker<string>(specOf);
    tr.press('trim');
    const times = run(tr, 2.0, 0.005);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(gaps[1]).toBeCloseTo(0.1, 6);
    expect(gaps[gaps.length - 1]).toBeCloseTo(0.05, 6);
  });

  it('stops repeating on release; non-repeat actions fire once', () => {
    const tr = new HoldTracker<string>(specOf);
    tr.press('brakes');
    expect(run(tr, 1, 0.01).length).toBe(1);
    tr.press('thr');
    run(tr, 0.5, 0.01);
    tr.release('thr');
    expect(run(tr, 1, 0.01).length).toBe(0);
  });

  it('a tap shorter than a frame is still reported (edge + one held poll)', () => {
    const tr = new HoldTracker<string>(specOf);
    tr.press('brakes');
    tr.release('brakes');
    const held: string[] = [];
    const edges: string[] = [];
    tr.poll(DT, (a) => edges.push(a), (a) => held.push(a));
    expect(edges).toEqual(['brakes']);
    expect(held).toEqual(['brakes']);
    held.length = 0;
    tr.poll(DT, () => undefined, (a) => held.push(a));
    expect(held).toEqual([]);
  });

  it('counts multiple inputs holding the same action', () => {
    const tr = new HoldTracker<string>(specOf);
    tr.press('brakes');
    tr.press('brakes');
    tr.release('brakes');
    expect(tr.isHeld('brakes')).toBe(true);
    tr.release('brakes');
    expect(tr.isHeld('brakes')).toBe(false);
    tr.press('brakes');
    tr.releaseAll();
    expect(tr.isHeld('brakes')).toBe(false);
  });
});
