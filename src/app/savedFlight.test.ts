import { describe, expect, it } from 'vitest';
import { parseSavedFlight, savedFlightLabel } from './savedFlight';

const good = {
  v: 1, savedAtMs: 1, aircraftId: 'pa18-150', airportIcao: 'KOAK', geo: { lat: 37.7, lon: -122.2, alt: 700 }, headingRad: 2, onGround: false,
  frame: { lat0: 37.7, lon0: -122.2, alt0: 0 }, fdm: '{}', controls: {}, weather: {}, utcMs: 0, plan: [], activeLeg: 0, failures: [],
};

describe('saved flight', () => {
  it('parses a valid save and rejects anything else', () => {
    expect(parseSavedFlight(JSON.stringify(good))?.aircraftId).toBe('pa18-150');
    expect(parseSavedFlight(null)).toBeNull();
    expect(parseSavedFlight('not json')).toBeNull();
    expect(parseSavedFlight(JSON.stringify({ ...good, v: 2 }))).toBeNull();
    expect(parseSavedFlight(JSON.stringify({ ...good, fdm: undefined }))).toBeNull();
    expect(parseSavedFlight(JSON.stringify({ ...good, geo: { lat: null, lon: 0, alt: 0 } }))).toBeNull();
  });

  it('describes it', () => {
    expect(savedFlightLabel(good, 'Super Cub')).toBe('Super Cub in flight near KOAK');
    expect(savedFlightLabel({ ...good, airportIcao: null, onGround: true }, 'C172')).toBe('C172 on the ground at 37.70°, -122.20°');
  });
});
