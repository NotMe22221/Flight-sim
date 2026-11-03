import { describe, expect, it } from 'vitest';
import { localMinutesToUtc, sunHint, timeReadout, utcToLocalMinutes } from './timeOfDay';

const NOV3_2026_0000Z = Date.UTC(2026, 10, 3, 0, 0);

describe('local clock mapping', () => {
  it('maps local minutes to UTC on the local day and back', () => {
    const off = -480; // San Francisco, UTC-8 (longitude based)
    const now = NOV3_2026_0000Z + 20 * 3_600_000; // 20:00Z = 12:00 local
    const utc = localMinutesToUtc(14 * 60 + 30, off, now);
    expect(new Date(utc).toISOString()).toBe('2026-11-03T22:30:00.000Z');
    expect(utcToLocalMinutes(utc, off)).toBe(14 * 60 + 30);
  });
  it('uses the local day, not the UTC day', () => {
    const off = -480;
    const now = NOV3_2026_0000Z + 3 * 3_600_000; // 03:00Z = 19:00 local on Nov 2
    const utc = localMinutesToUtc(6 * 60, off, now);
    expect(new Date(utc).toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });
  it('wraps negative minutes into the day', () => {
    expect(utcToLocalMinutes(NOV3_2026_0000Z, 60)).toBe(60);
    expect(utcToLocalMinutes(NOV3_2026_0000Z, -60)).toBe(1380);
  });
  it('formats a readout with local time, offset and UTC', () => {
    expect(timeReadout(NOV3_2026_0000Z + 22.5 * 3_600_000, -122.4)).toBe('14:30 local (UTC-8) · 22:30Z');
  });
});

describe('sunHint', () => {
  it('is daylight at local noon and night at local midnight in San Francisco', () => {
    const noon = sunHint(Date.UTC(2026, 5, 21, 20, 0), 37.6, -122.4);
    expect(noon.phase).toBe('day');
    expect(noon.night).toBe(false);
    expect(noon.text).toMatch(/^Day · sun \+\d+°$/);
    const midnight = sunHint(Date.UTC(2026, 5, 21, 8, 0), 37.6, -122.4);
    expect(midnight.night).toBe(true);
    expect(midnight.text).toContain('sun −');
  });
});
