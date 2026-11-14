import { describe, expect, it } from 'vitest';
import type { TrafficInfo } from '../core/types';
import { TrafficAdvisor, altitudeWords, clockPosition, rangeBearing } from './advisor';

const at = (lat: number, lon: number, altFt: number, leg = 'downwind'): TrafficInfo => ({ callsign: 'N123AB', type: 'Cessna 172', lat, lon, altMslM: altFt * 0.3048, headingDeg: 0, groundSpeedMs: 45, verticalSpeedMs: 0, onGround: false, leg });
const player = { lat: 37.5, lon: -122.5, altMslM: 1000 * 0.3048, headingDeg: 0, onGround: false };

describe('TrafficAdvisor', () => {
  it('clock positions and phrasing helpers', () => {
    expect(clockPosition(0, 0)).toBe(12);
    expect(clockPosition(0, 60)).toBe(2);
    expect(clockPosition(90, 0)).toBe(9);
    expect(clockPosition(350, 175)).toBe(6);
    expect(altitudeWords(1050)).toBe('one thousand one hundred');
    expect(altitudeWords(800)).toBe('eight hundred');
    expect(rangeBearing(37.5, -122.5, 37.51, -122.5).bearingDeg).toBeCloseTo(0, 3);
  });

  it('calls converging traffic within 2 nm and 1,000 ft once per 90 s, with clock, range, type, leg and altitude', () => {
    const adv = new TrafficAdvisor();
    // about 1.4 nm to the north-east (45°: one o'clock), then closer
    expect(adv.check(0, player, [at(37.518, -122.478, 1100)], 'Skyhawk 2FS')).toEqual([]); // first sample: no trend yet
    const calls = adv.check(1, player, [at(37.516, -122.48, 1100)], 'Skyhawk 2FS');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("Skyhawk 2FS, traffic, one o'clock, one mile, Cessna on left downwind, one thousand one hundred.");
    expect(adv.check(30, player, [at(37.514, -122.482, 1100)], 'Skyhawk 2FS')).toEqual([]); // repeat suppressed
    expect(adv.check(95, player, [at(37.511, -122.485, 1100)], 'Skyhawk 2FS')).toHaveLength(1);
  });

  it('stays quiet for distant, separated, diverging or ground traffic, and while the player is on the ground', () => {
    const adv = new TrafficAdvisor();
    const far = at(37.56, -122.5, 1000), high = at(37.505, -122.5, 2500), ground = { ...at(37.502, -122.5, 1000), onGround: true };
    adv.check(0, player, [far, high, ground], 'N1');
    expect(adv.check(1, player, [far, high, ground], 'N1')).toEqual([]);
    // diverging beyond 0.75 nm: no call
    adv.check(2, player, [at(37.512, -122.5, 1000)], 'N1');
    expect(adv.check(3, player, [at(37.514, -122.5, 1000)], 'N1')).toEqual([]);
    expect(adv.check(4, { ...player, onGround: true }, [at(37.501, -122.5, 1000)], 'N1')).toEqual([]);
  });
});
