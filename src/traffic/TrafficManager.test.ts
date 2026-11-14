import { describe, expect, it } from 'vitest';
import { C172S } from '../fdm/aircraft/c172';
import type { Airport, Runway } from '../core/types';
import { chooseRunway, eulerToQNB, toRunwayCoords, trafficCount } from './TrafficManager';
import type { PatternRunway } from './pattern';

/** Rotate a body vector into NED with qNB (conjugate rotation). */
function bodyToNed(q: number[], v: number[]): number[] {
  const [w, x, y, z] = [q[0], -q[1], -q[2], -q[3]]; // q_BN
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

const rwy = (ident: string, headingDeg: number, lengthM = 1500): Runway => ({ ident, headingDeg, lengthM, widthM: 30, surface: 'asphalt', lighted: true, displacedThresholdM: 0, threshold: { lat: 37, lon: -122, alt: 10 }, end: { lat: 37.01, lon: -122, alt: 10 } });
const ap = (type: Airport['type'], runways: Runway[]): Airport => ({ icao: 'KXYZ', name: 'X', position: { lat: 37, lon: -122, alt: 10 }, elevationM: 10, type, country: 'US', runways });

describe('traffic geometry', () => {
  it('eulerToQNB: heading 90° points the nose east, a right roll drops the right wing, nose-up raises the nose', () => {
    const q = [1, 0, 0, 0] as [number, number, number, number];
    eulerToQNB(0, 0, Math.PI / 2, q);
    const nose = bodyToNed(q, [1, 0, 0]);
    expect(nose[1]).toBeCloseTo(1, 6);
    eulerToQNB(0.3, 0, 0, q);
    expect(bodyToNed(q, [0, 1, 0])[2]).toBeGreaterThan(0.2); // right wing down (NED z +)
    eulerToQNB(0, 0.2, 0, q);
    expect(bodyToNed(q, [1, 0, 0])[2]).toBeLessThan(-0.15); // nose up (NED z −)
  });

  it('toRunwayCoords inverts the circuit projection', () => {
    const r: PatternRunway = { lat: 37.6, lon: -122.4, elevM: 4, endElevM: 4, headingDeg: 280, lengthM: 2300, side: 'left' };
    const H = (280 * Math.PI) / 180, R = 6378137;
    const x = 1200, y = -800;
    const n = x * Math.cos(H) - y * Math.sin(H), e = x * Math.sin(H) + y * Math.cos(H);
    const lat = r.lat + (n / R) * (180 / Math.PI), lon = r.lon + (e / (R * Math.cos((r.lat * Math.PI) / 180))) * (180 / Math.PI);
    const c = toRunwayCoords(r, lat, lon);
    expect(c.x).toBeCloseTo(x, 0); expect(c.y).toBeCloseTo(y, 0);
  });

  it('chooses the runway most into the wind, keeps the player runway in calm air, skips short and water runways', () => {
    const a = ap('small', [rwy('28', 280), rwy('10', 100), rwy('01', 10, 300)]);
    expect(chooseRunway(a, 270, 10)?.ident).toBe('28');
    expect(chooseRunway(a, 90, 10)?.ident).toBe('10');
    expect(chooseRunway(a, 270, 1, '10')?.ident).toBe('10');
    expect(chooseRunway(ap('small', [rwy('01', 10, 300)]), 0, 10)).toBeNull();
    expect(chooseRunway(ap('small', [{ ...rwy('18', 180), surface: 'water' }]), 180, 5)).toBeNull();
  });

  it('traffic counts by airport type', () => {
    expect(trafficCount(ap('small', []))).toBe(2);
    expect(trafficCount(ap('large', []))).toBe(1);
    expect(trafficCount(ap('heliport', []))).toBe(0);
    expect(C172S.gear.length).toBeGreaterThanOrEqual(3);
  });
});
