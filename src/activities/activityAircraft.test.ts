/** Activities fly a fixed aircraft: the Pacific Coast bush trip the Super Cub, the lessons the 172. */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/events';
import { C172S } from '../fdm/aircraft/c172';
import { PA18_150 } from '../fdm/aircraft/cub';
import { ActivityRunner } from './ActivityRunner';
import { FakeHost } from './activityTestKit';
import { BUSH_TRIPS, PACIFIC_COAST, bushLegActivity } from './bushTrips';
import { LESSONS } from './lessons';

describe('activity aircraft', () => {
  it('the Pacific Coast trip and each of its legs fly the Super Cub; lessons the 172', () => {
    expect(PACIFIC_COAST.aircraft).toBe(PA18_150.id);
    expect(PACIFIC_COAST.description).toMatch(/Super Cub/);
    for (let i = 0; i < PACIFIC_COAST.legs.length; i++) expect(bushLegActivity(PACIFIC_COAST, i).aircraft).toBe(PA18_150.id);
    for (const t of BUSH_TRIPS) expect(t.aircraft.length).toBeGreaterThan(0);
    for (const l of LESSONS) expect(C172S.id.startsWith(l.aircraft ?? '')).toBe(true);
  });

  it('the runner asks the host for the activity\'s aircraft before the spawn', async () => {
    const host = new FakeHost();
    const runner = new ActivityRunner({ host, events: new EventBus(), progress: null });
    await runner.start(bushLegActivity(PACIFIC_COAST, 0));
    expect(host.aircraft).toEqual([{ family: 'pa18-150', atCall: 0 }]);
    expect(host.calls[0]).toMatch(/^weather /);
    expect(host.calls.some((c) => c.startsWith('spawnAtRunway KHAF'))).toBe(true);
    await runner.start(LESSONS[0]);
    expect(host.aircraft[1].family).toBe('c172');
    runner.abort();
  });

  it('an activity without an aircraft leaves the host\'s aircraft alone', async () => {
    const host = new FakeHost();
    const runner = new ActivityRunner({ host, events: new EventBus(), progress: null });
    await runner.start({ ...LESSONS[0], aircraft: undefined });
    expect(host.aircraft).toEqual([]);
    runner.abort();
  });
});
