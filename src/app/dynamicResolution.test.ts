import { describe, expect, it } from 'vitest';
import { DynamicResolution } from './dynamicResolution';

const run = (d: DynamicResolution, fps: number, seconds: number) => { for (let t = 0; t < seconds; t += 1 / fps) d.update(1 / fps); };

describe('DynamicResolution', () => {
  it('holds full resolution at vsync', () => {
    const d = new DynamicResolution();
    run(d, 60, 30);
    expect(d.scale).toBe(1);
  });

  it('steps down while slow, never below the minimum', () => {
    const d = new DynamicResolution();
    run(d, 25, 3);
    expect(d.scale).toBeLessThan(1);
    run(d, 10, 60);
    expect(d.scale).toBe(0.5);
    const crawl = new DynamicResolution();
    run(crawl, 4, 10); // a software renderer: every frame is a quarter second
    expect(crawl.scale).toBeLessThan(1);
  });

  it('steps back up when there is headroom, but not straight back to a scale that was too slow', () => {
    const d = new DynamicResolution({ ceilingHoldS: 20 });
    run(d, 25, 1.6); // one step down from 1
    const s = d.scale;
    expect(s).toBeCloseTo(0.9);
    run(d, 60, 15); // fast again: creeps up, but the ceiling (1, too slow) blocks the return for 20 s
    expect(d.scale).toBeGreaterThan(s);
    expect(d.scale).toBeLessThan(1);
    run(d, 60, 20);
    expect(d.scale).toBe(1);
  });

  it('ignores stalls and middling frame rates; disabled means full scale', () => {
    const d = new DynamicResolution();
    d.update(2); d.update(1.5);
    run(d, 48, 20);
    expect(d.scale).toBe(1);
    run(d, 20, 5);
    expect(d.scale).toBeLessThan(1);
    d.enabled = false;
    expect(d.update(1 / 20)).toBe(true);
    expect(d.scale).toBe(1);
  });
});
