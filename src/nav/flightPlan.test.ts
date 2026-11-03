import { describe, expect, it } from 'vitest';
import type { Geodetic, Waypoint } from '../core/types';
import { NM } from '../core/units';
import { destinationPoint, greatCircleDistance, initialBearingDeg } from '../geo/wgs84';
import { FlightPlanner, waypointFromAirport } from './flightPlan';

const KSFO: Geodetic = { lat: 37.619806, lon: -122.374821, alt: 4 };
const KHAF: Geodetic = { lat: 37.513401, lon: -122.500999, alt: 20.1 };
const LOWI: Geodetic = { lat: 47.260201, lon: 11.344, alt: 581.3 };
const plan = (): Waypoint[] => [
  waypointFromAirport({ icao: 'KSFO', position: KSFO }),
  waypointFromAirport({ icao: 'KHAF', position: KHAF }),
  waypointFromAirport({ icao: 'LOWI', position: LOWI }),
];
const GS = 60; // m/s

describe('FlightPlanner', () => {
  it('KSFO→KHAF→LOWI: leg distances sum to the total and the first leg is active', () => {
    const fp = new FlightPlanner(plan());
    const leg1 = greatCircleDistance(KSFO, KHAF), leg2 = greatCircleDistance(KHAF, LOWI);
    expect(fp.totalDistanceM()).toBeCloseTo(leg1 + leg2, 6);
    expect(leg1 / NM).toBeGreaterThan(8);
    expect(leg1 / NM).toBeLessThan(10);
    expect(leg2 / NM).toBeGreaterThan(5000);
    expect(fp.activeLeg).toBe(1);
    const s = fp.update(KSFO, GS)!;
    expect(s.activeLeg).toBe(1);
    expect(s.waypoints).toHaveLength(3);
    expect(s.distanceToActiveM).toBeCloseTo(leg1, 3);
    expect(s.bearingToActiveDeg).toBeCloseTo(initialBearingDeg(KSFO, KHAF), 6);
    expect(s.desiredTrackDeg).toBeCloseTo(initialBearingDeg(KSFO, KHAF), 1);
    expect(Math.abs(s.crossTrackM)).toBeLessThan(1);
    expect(s.totalDistanceM).toBeCloseTo(leg1 + leg2, 6);
    expect(s.remainingDistanceM).toBeCloseTo(leg1 + leg2, 3);
    expect(s.eteS).toBeCloseTo(leg1 / GS, 3);
    expect(s.eteTotalS).toBeCloseTo((leg1 + leg2) / GS, 3);
    expect(s.complete).toBe(false);
    expect(fp.update(KSFO, 0)!.eteS).toBe(Infinity);
  });

  it('cross-track error is + right of course', () => {
    const fp = new FlightPlanner(plan());
    const course = initialBearingDeg(KSFO, KHAF);
    const mid = destinationPoint(KSFO, course, greatCircleDistance(KSFO, KHAF) / 2);
    const right = destinationPoint(mid, course + 90, 1000);
    const left = destinationPoint(mid, course - 90, 1000);
    expect(fp.update(right, GS)!.crossTrackM).toBeCloseTo(1000, -1);
    expect(fp.update(left, GS)!.crossTrackM).toBeCloseTo(-1000, -1);
    expect(fp.activeLeg).toBe(1);
  });

  it('sequences to the next leg at the turn-anticipation distance or when passed abeam', () => {
    const fp = new FlightPlanner(plan());
    const course = initialBearingDeg(KSFO, KHAF);
    const before = (m: number) => destinationPoint(KHAF, course + 180, m);
    expect(fp.update(before(3000), GS)!.activeLeg).toBe(1);
    // r = 60²/(g·tan25°) ≈ 787 m; the course change is > 90° so anticipation = r
    expect(fp.update(before(1500), GS)!.activeLeg).toBe(1);
    const s = fp.update(before(500), GS)!;
    expect(s.activeLeg).toBe(2);
    expect(s.desiredTrackDeg).toBeCloseTo(initialBearingDeg(KHAF, LOWI), 0);
    expect(s.distanceToActiveM).toBeCloseTo(greatCircleDistance(before(500), LOWI), 3);
    // Passing abeam with no anticipation (ground speed 0 → zero turn radius)
    const fp2 = new FlightPlanner(plan());
    expect(fp2.update(before(200), 0)!.activeLeg).toBe(1);
    expect(fp2.update(destinationPoint(KHAF, course, 200), 0)!.activeLeg).toBe(2);
    // Far off-track abeam the waypoint does not sequence early by anticipation alone
    const fp3 = new FlightPlanner(plan());
    const offTrack = destinationPoint(before(500), course + 90, 5000);
    expect(fp3.update(offTrack, GS)!.activeLeg).toBe(1);
  });

  it('never sequences past the last waypoint; marks the plan complete when it is passed', () => {
    const fp = new FlightPlanner(plan());
    fp.activate(2);
    expect(fp.update(destinationPoint(LOWI, 0, 0), GS)!.complete).toBe(false); // at the waypoint
    // The great circle from KHAF bends a lot over 5000 nm: use the final (inbound) course at LOWI.
    const finalCourse = initialBearingDeg(LOWI, KHAF) + 180;
    const beyond = destinationPoint(LOWI, finalCourse, 2000); // 2 km beyond along the inbound course
    const s = fp.update(beyond, GS)!;
    expect(s.activeLeg).toBe(2);
    expect(s.complete).toBe(true);
    expect(s.remainingDistanceM).toBeCloseTo(2000, -1);
  });

  it('direct-to flies from the present position', () => {
    const fp = new FlightPlanner(plan());
    const here = destinationPoint(KSFO, 90, 20_000);
    fp.directTo(2, here);
    expect(fp.activeLeg).toBe(2);
    expect(fp.legOrigin()).toEqual(here);
    const s = fp.update(here, GS)!;
    expect(Math.abs(s.crossTrackM)).toBeLessThan(1);
    expect(s.desiredTrackDeg).toBeCloseTo(initialBearingDeg(here, LOWI), 1);
    // direct-to a new user waypoint appends it
    const user: Waypoint = { id: 'USR1', position: destinationPoint(here, 0, 50_000), type: 'user' };
    fp.directTo(user, here);
    expect(fp.waypoints).toHaveLength(4);
    expect(fp.activeLeg).toBe(3);
    expect(fp.activeWaypoint).toBe(user);
    fp.directTo(99, here); // ignored
    expect(fp.activeLeg).toBe(3);
  });

  it('add / insert / remove keep the active waypoint sensible', () => {
    const fp = new FlightPlanner();
    expect(fp.update(KSFO, GS)).toBeNull();
    fp.add(waypointFromAirport({ icao: 'KHAF', position: KHAF }));
    expect(fp.activeLeg).toBe(0);
    const s = fp.update(KSFO, GS)!; // single waypoint: direct from here
    expect(s.distanceToActiveM).toBeCloseTo(greatCircleDistance(KSFO, KHAF), 3);
    fp.insert(0, waypointFromAirport({ icao: 'KSFO', position: KSFO }));
    expect(fp.waypoints[0].id).toBe('KSFO');
    expect(fp.activeWaypoint?.id).toBe('KHAF');
    fp.add(waypointFromAirport({ icao: 'LOWI', position: LOWI }));
    fp.insert(99, { id: 'END', position: LOWI, type: 'user' });
    expect(fp.waypoints.map((w) => w.id)).toEqual(['KSFO', 'KHAF', 'LOWI', 'END']);
    fp.remove(0); // before the active one
    expect(fp.activeWaypoint?.id).toBe('KHAF');
    fp.remove(0); // the active one → next becomes active
    expect(fp.activeWaypoint?.id).toBe('LOWI');
    fp.remove(5); // no-op
    expect(fp.waypoints).toHaveLength(2);
    fp.clear();
    expect(fp.waypoints).toHaveLength(0);
    expect(fp.update(KSFO, GS)).toBeNull();
    fp.setWaypoints(plan());
    expect(fp.activeLeg).toBe(1);
  });
});
