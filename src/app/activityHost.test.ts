import { describe, expect, it } from 'vitest';
import { makeActivityHost } from './activityHost';
import type { Simulator } from './Simulator';

describe('activity host runway spawn', () => {
  it('loads the region of a small airport that is not in memory yet, then spawns there', async () => {
    const loaded: { lat: number; lon: number; r: number }[] = [];
    let inMemory = false;
    const kwvi = { icao: 'KWVI', position: { lat: 36.9357, lon: -121.79, alt: 50 }, runways: [] };
    const spawned: string[] = [];
    const sim = {
      nav: {
        load: async () => {},
        getAirport: (icao: string) => (icao === 'KWVI' && inMemory ? kwvi : undefined),
        loadRegion: async (c: { lat: number; lon: number }, r: number) => { loaded.push({ lat: c.lat, lon: c.lon, r }); if (Math.abs(c.lat - 36.93) < 0.1) inMemory = true; },
      },
      spawnAtRunway: async (ap: { icao: string }, rwy: string) => { spawned.push(`${ap.icao} ${rwy}`); },
      input: { controls: { parkingBrake: false } },
    } as unknown as Simulator;
    const host = makeActivityHost(sim);
    await host.spawnAtRunway('KWVI', '27', { near: { lat: 36.9357, lon: -121.79 } });
    expect(spawned).toEqual(['KWVI 27']);
    expect(loaded[0].lat).toBeCloseTo(36.9357);
    // without a hint it still fails clearly
    inMemory = false;
    await expect(host.spawnAtRunway('KWVI', '27')).rejects.toThrow(/not in the airport database/);
  });
});
