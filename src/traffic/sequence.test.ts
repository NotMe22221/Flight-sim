import { describe, expect, it } from 'vitest';
import { C172S } from '../fdm/aircraft/c172';
import { PA18_150 } from '../fdm/aircraft/cub';
import type { Airport } from '../core/types';
import { TrafficManager } from './TrafficManager';

const LAT0 = 37.5, LON0 = -122.5;
const kx = 6378137 * (Math.PI / 180) * Math.cos((LAT0 * Math.PI) / 180), ky = 6378137 * (Math.PI / 180);
const geo = (e: number, n: number) => ({ lat: LAT0 + n / ky, lon: LON0 + e / kx });
const AP: Airport = {
  icao: 'KTST', name: 'Test', position: { ...geo(1000, 0), alt: 5 }, elevationM: 5, type: 'medium', country: 'US',
  runways: [{ ident: '09', headingDeg: 90, lengthM: 2000, widthM: 30, surface: 'asphalt', lighted: true, displacedThresholdM: 0, threshold: { ...geo(0, 0), alt: 5 }, end: { ...geo(2000, 0), alt: 5 } }],
};

describe('TrafficManager.aheadOf (ATC sequencing)', () => {
  it('names the aircraft immediately ahead in the landing sequence', () => {
    const tm = new TrafficManager({ c172: C172S, cub: PA18_150, maxAircraft: 2 });
    tm.setAirport(AP, 90, 10, null);
    const sims = (tm as unknown as { ai: { sim: { place(l: string, a: number): void; x: number } }[] }).ai.map((a) => a.sim);
    expect(sims.length).toBe(2);
    sims[0].place('base', 0.5);
    sims[1].place('final', 0.7); // ~420 m before the threshold
    // the player on downwind: follows the aircraft on base (the last one in)
    const downwind = geo(-500, -1500);
    expect(tm.aheadOf(downwind.lat, downwind.lon)).toEqual({ type: 'Cessna', leg: 'base' });
    // the player on a 2.5 km final: the aircraft closer in on final is ahead
    const longFinal = geo(-2500, 0);
    expect(tm.aheadOf(longFinal.lat, longFinal.lon)).toEqual({ type: 'Cessna', leg: 'final' });
    // the player on short final ahead of everyone: nobody to follow
    const shortFinal = geo(-200, 0);
    expect(tm.aheadOf(shortFinal.lat, shortFinal.lon)).toBeNull();
    // nobody in sequence: null
    sims[0].place('downwind', 0.5); sims[1].place('crosswind', 0.5);
    expect(tm.aheadOf(downwind.lat, downwind.lon)).toBeNull();
    tm.dispose();
  }, 60_000);
});
