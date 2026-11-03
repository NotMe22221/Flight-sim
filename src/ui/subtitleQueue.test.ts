import { describe, expect, it } from 'vitest';
import { SUBTITLE_MAX_STEP_MS, SubtitleQueue, type SubtitleLine } from './subtitleQueue';

const line = (text: string, durationMs = 6000, important = false): SubtitleLine => ({ text, speaker: 'Instructor', important, durationMs });

/** Advance in 16 ms frames from `t0` to `t1`; returns the texts shown, in order, without repeats. */
function run(q: SubtitleQueue, t0: number, t1: number, paused = false): string[] {
  const seen: string[] = [];
  for (let t = t0; t <= t1; t += 16) {
    const l = q.update(t, paused);
    const s = l ? l.text : '-';
    if (seen[seen.length - 1] !== s) seen.push(s);
  }
  return seen;
}

describe('instructor subtitle queue', () => {
  it('shows a line at the next frame and hides it after its duration', () => {
    const q = new SubtitleQueue();
    q.update(0);
    q.push(line('Hold 3,000 ft.', 6000));
    expect(q.update(16)?.text).toBe('Hold 3,000 ft.');
    expect(run(q, 32, 6100)).toEqual(['Hold 3,000 ft.', '-']);
  });
  it('plays a burst in order, each readable for at least the minimum', () => {
    const q = new SubtitleQueue(2500);
    q.update(0);
    q.push(line('Nicely held.'));
    q.push(line('Now climb to 3,500 ft.', 9000, true));
    const seen = run(q, 16, 20000);
    expect(seen).toEqual(['Nicely held.', 'Now climb to 3,500 ft.', '-']);
    // the first line made way after ~2.5 s, the second stayed its full 9 s
    const q2 = new SubtitleQueue(2500);
    q2.update(0); q2.push(line('A')); q2.push(line('B', 9000));
    let switchedAt = -1;
    for (let t = 16; t < 20000 && switchedAt < 0; t += 16) if (q2.update(t)?.text === 'B') switchedAt = t;
    expect(switchedAt).toBeGreaterThanOrEqual(2500);
    expect(switchedAt).toBeLessThan(2600);
  });
  it('does not count paused time or long gaps off the flight view', () => {
    const q = new SubtitleQueue();
    q.update(0);
    q.push(line('Trim for hands-off flight.', 6000));
    q.update(16);
    run(q, 32, 60000, true); // a minute paused
    expect(q.current?.text).toBe('Trim for hands-off flight.');
    // a two-minute gap (menus, loading screen) counts as one capped step
    q.update(180000);
    expect(q.current?.text).toBe('Trim for hands-off flight.');
    expect(SUBTITLE_MAX_STEP_MS).toBeLessThan(1000);
  });
  it('keeps a repeated line up instead of queueing it twice', () => {
    const q = new SubtitleQueue();
    q.update(0);
    q.push(line('Level the wings.'));
    q.update(16);
    run(q, 32, 5000);
    q.push(line('Level the wings.'));
    expect(q.pending).toBe(0);
    expect(run(q, 5016, 10000)).toEqual(['Level the wings.']); // restarted: still up 5 s later
    q.push(line('Climb.')); q.push(line('Climb.'));
    expect(q.pending).toBe(1);
  });
  it('drops the oldest unimportant line when too many wait', () => {
    const q = new SubtitleQueue(2500, 2);
    q.update(0);
    q.push(line('now'));
    q.update(16);
    q.push(line('hint 1'));
    q.push(line('instruction', 9000, true));
    q.push(line('hint 2'));
    expect(q.pending).toBe(2);
    expect(run(q, 32, 30000)).toEqual(['now', 'instruction', 'hint 2', '-']);
  });
  it('clears', () => {
    const q = new SubtitleQueue();
    q.push(line('x')); q.update(0);
    q.clear();
    expect(q.update(16)).toBeNull();
    q.push(line(''));
    expect(q.update(32)).toBeNull();
  });
});
