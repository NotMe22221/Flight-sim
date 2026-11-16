import { describe, expect, it } from 'vitest';
import { C172S } from '../fdm/aircraft/c172';
import { PA18_150 } from '../fdm/aircraft/cub';
import { makeAircraftState } from '../core/fakeState';
import type { Airport } from '../core/types';
import { TaxiGraph } from '../world/taxiGraph';
import { TrafficManager } from './TrafficManager';

const LAT0 = 37.5, LON0 = -122.5;
const kx = 6378137 * (Math.PI / 180) * Math.cos((LAT0 * Math.PI) / 180), ky = 6378137 * (Math.PI / 180);
const geo = (e: number, n: number) => ({ lat: LAT0 + n / ky, lon: LON0 + e / kx });
const ll = (...pts: [number, number][]) => pts.flatMap(([e, n]) => { const g = geo(e, n); return [g.lon, g.lat]; });

// runway 09 along +east from (0,0), 2000 m; parallel taxiway A at 200 m north, connectors B1/B2, stub C to an apron
const AP: Airport = {
  icao: 'KTST', name: 'Test', position: { ...geo(1000, 0), alt: 5 }, elevationM: 5, type: 'small', country: 'US',
  runways: [{ ident: '09', headingDeg: 90, lengthM: 2000, widthM: 30, surface: 'asphalt', lighted: true, displacedThresholdM: 0, threshold: { ...geo(0, 0), alt: 5 }, end: { ...geo(2000, 0), alt: 5 } }],
};
const LINES = [
  { line: ll([0, 200], [2000, 200]), ref: 'A' },
  { line: ll([100, 200], [100, 50]), ref: 'B1' },
  { line: ll([1900, 200], [1900, 50]), ref: 'B2' },
  { line: ll([1000, 500], [1000, 200]), ref: 'C' },
];
const STAND = { ...geo(1000, 540), headingDeg: 180 };

describe('TrafficManager ground cycle', () => {
  it('a stand aircraft taxis out, departs, comes back as an arrival, taxis in and parks at its stand again', () => {
    const tm = new TrafficManager({ c172: C172S, cub: PA18_150, maxAircraft: 2 });
    const graph = new TaxiGraph(AP.position.lat, AP.position.lon, LINES);
    tm.setAirport(AP, 90, 8, null);
    tm.setGround(graph, [STAND], null);
    const player = makeAircraftState({ geo: { ...geo(-20000, 0), alt: 5 }, onGround: true });
    const frame = { geodeticToThree: () => [0, 0, 0] };
    const ground = () => (tm as unknown as { ai: { stand?: unknown; sim: { leg: string; x: number; y: number } }[] }).ai.find((a) => a.stand)!.sim;
    expect(ground().leg).toBe('parked');
    const legs: string[] = [];
    for (let t = 0; t < 1800; t++) {
      tm.update(1, 0.016, player, frame, 0.5);
      const l = ground().leg;
      if (legs[legs.length - 1] !== l) legs.push(l);
    }
    for (const l of ['taxi', 'holding', 'lineup', 'takeoff', 'upwind', 'final', 'landing', 'parked']) expect(legs, l).toContain(l);
    // it ended up back at its stand (parked after the full cycle)
    const firstLanding = legs.indexOf('landing');
    expect(legs.slice(firstLanding)).toContain('parked');
    tm.dispose();
  }, 120_000);
});
