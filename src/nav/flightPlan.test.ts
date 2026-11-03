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

  it('removing the waypoint before the active one keeps a direct-to origin', () => {
    const extra: Waypoint = { id: 'USR', position: destinationPoint(KHAF, 270, 30_000), type: 'user' };
    const fp = new FlightPlanner([...plan(), extra]);
    const here = destinationPoint(KSFO, 180, 10_000);
    fp.directTo(3, here); // direct to USR
    fp.remove(2); // drop LOWI, the waypoint just before the active one
    expect(fp.activeWaypoint?.id).toBe('USR');
    expect(fp.legOrigin()).toEqual(here); // still flying direct from where D→ was pressed
    expect(Math.abs(fp.update(here, GS)!.crossTrackM)).toBeLessThan(1);
    // removing the active waypoint itself cancels the direct-to and activates the next one
    const fp2 = new FlightPlanner([...plan(), extra]);
    fp2.directTo(2, here);
    fp2.remove(2);
    expect(fp2.activeWaypoint?.id).toBe('USR');
    expect(fp2.legOrigin()).toEqual(KHAF);
  });

  it('desired track and cross-track stay finite on a zero-length leg', () => {
    const fp = new FlightPlanner([waypointFromAirport({ icao: 'A', position: KSFO }), waypointFromAirport({ icao: 'B', position: KSFO })]);
    const s = fp.update(destinationPoint(KSFO, 45, 1000), GS)!;
    for (const v of [s.desiredTrackDeg, s.crossTrackM, s.distanceToActiveM, s.bearingToActiveDeg, s.remainingDistanceM]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('FlightPlanner editing (G1000 FPL / D→ / OBS)', () => {
  const W = (id: string, p: Geodetic, type: Waypoint['type'] = 'user'): Waypoint => ({ id, position: p, type });
  /** a 12-waypoint plan heading east from KSFO, 10 km legs */
  const long = (): Waypoint[] => Array.from({ length: 12 }, (_, i) => W(`WP${String(i).padStart(2, '0')}`, destinationPoint(KSFO, 90, i * 10_000)));

  it('version increments on every edit, activation and direct-to', () => {
    const fp = new FlightPlanner();
    const seen = new Set<number>([fp.version]);
    const step = (f: () => void) => { const v = fp.version; f(); expect(fp.version).not.toBe(v); seen.add(fp.version); };
    step(() => fp.setWaypoints(long()));
    step(() => fp.insert(3, W('INS', destinationPoint(KSFO, 0, 5000))));
    step(() => fp.remove(3));
    step(() => fp.add(W('END', destinationPoint(KSFO, 90, 200_000))));
    step(() => fp.activateLeg(5));
    step(() => fp.directTo(7, KSFO));
    step(() => fp.cancelDirectTo());
    step(() => fp.setObs(90));
    step(() => fp.setObs(null));
    expect(seen.size).toBe(10);
    // the published state carries the version
    expect(fp.update(KSFO, GS)!.version).toBe(fp.version);
  });

  it('activateLeg flies from the previous waypoint and cancels a direct-to', () => {
    const fp = new FlightPlanner(long());
    fp.directTo(4, destinationPoint(KSFO, 180, 5000));
    expect(fp.isDirectTo).toBe(true);
    fp.activateLeg(6);
    expect(fp.isDirectTo).toBe(false);
    expect(fp.activeLeg).toBe(6);
    expect(fp.legOrigin()).toEqual(fp.waypoints[5].position);
    const s = fp.update(fp.waypoints[5].position, GS)!;
    expect(s.directTo).toBe(false);
    expect(s.legFrom.lat).toBeCloseTo(fp.waypoints[5].position.lat, 9);
    expect(s.desiredTrackDeg).toBeCloseTo(initialBearingDeg(fp.waypoints[5].position, fp.waypoints[6].position), 1);
    fp.activateLeg(-1); fp.activateLeg(99); // ignored
    expect(fp.activeLeg).toBe(6);
  });

  it('insert / remove on a 12-waypoint plan keep the active waypoint and the leg table consistent', () => {
    const fp = new FlightPlanner(long());
    fp.activateLeg(5);
    const active = fp.activeWaypoint;
    fp.insert(2, W('NEW1', destinationPoint(KSFO, 45, 8000)));
    fp.insert(fp.waypoints.length, W('NEW2', destinationPoint(KSFO, 90, 130_000)));
    expect(fp.waypoints).toHaveLength(14);
    expect(fp.activeWaypoint).toBe(active);
    expect(fp.activeLeg).toBe(6);
    fp.remove(0);
    expect(fp.activeWaypoint).toBe(active);
    expect(fp.indexOfId('new2')).toBe(12);
    expect(fp.indexOfId('nope')).toBe(-1);
    const s = fp.update(fp.waypoints[4].position, GS)!;
    expect(s.waypoints).toBe(fp.waypoints);
    expect(s.waypoints[s.activeLeg]).toBe(active);
  });

  it('directToWaypoint: in-plan by id, new plan when empty, off-route keeps the stored plan', () => {
    const here = destinationPoint(KSFO, 200, 15_000);
    // empty plan: the target becomes the plan
    const empty = new FlightPlanner();
    expect(empty.directToWaypoint(W('KOAK', KHAF, 'airport'), here)).toBe('new-plan');
    expect(empty.waypoints.map((w) => w.id)).toEqual(['KOAK']);
    expect(empty.update(here, GS)!.directTo).toBe(true);

    const fp = new FlightPlanner(long());
    // same id and position as a plan waypoint (a fresh object from the nav database) → in-plan
    const copy = W('WP07', { ...fp.waypoints[7].position });
    expect(fp.directToWaypoint(copy, here)).toBe('in-plan');
    expect(fp.activeLeg).toBe(7);
    expect(fp.offRouteTarget).toBeNull();
    let s = fp.update(here, GS)!;
    expect(s.directTo).toBe(true);
    expect(s.offRoute).toBe(false);
    expect(s.legFrom.lat).toBeCloseTo(here.lat, 9);

    // not in the plan → off-route: the snapshot plan is just the target, the stored plan stays
    const usr = W('USR9', destinationPoint(here, 0, 30_000));
    expect(fp.directToWaypoint(usr, here)).toBe('off-route');
    expect(fp.waypoints).toHaveLength(12);
    expect(fp.offRouteTarget).toBe(usr);
    expect(fp.activeWaypoint).toBe(usr);
    s = fp.update(here, GS)!;
    expect(s.offRoute).toBe(true);
    expect(s.waypoints).toEqual([usr]);
    expect(s.activeLeg).toBe(0);
    expect(s.distanceToActiveM).toBeCloseTo(30_000, -1);
    expect(s.desiredTrackDeg).toBeCloseTo(0, 0);
    expect(Math.abs(s.crossTrackM)).toBeLessThan(1);
    // no sequencing while off-route, even far past the target
    s = fp.update(destinationPoint(here, 0, 60_000), GS)!;
    expect(s.waypoints[0]).toBe(usr);
    expect(s.complete).toBe(true);
    // editing the stored plan during the D→ does not disturb it
    fp.remove(0);
    expect(fp.offRouteTarget).toBe(usr);
    // cancelling returns to the stored plan's active leg
    fp.cancelDirectTo();
    s = fp.update(here, GS)!;
    expect(s.offRoute).toBe(false);
    expect(s.waypoints).toBe(fp.waypoints);
    expect(s.waypoints[s.activeLeg].id).toBe('WP07');
  });

  it('removing every stored waypoint during an off-route D→ adopts the target as the plan', () => {
    const fp = new FlightPlanner([W('A', KSFO), W('B', KHAF)]);
    const t = W('T', destinationPoint(KSFO, 90, 20_000));
    fp.directToWaypoint(t, KSFO);
    fp.remove(0); fp.remove(0);
    expect(fp.waypoints).toEqual([t]);
    expect(fp.offRouteTarget).toBeNull();
    const s = fp.update(KSFO, GS)!;
    expect(s.directTo).toBe(true);
    expect(s.distanceToActiveM).toBeCloseTo(20_000, -1);
  });

  it('OBS mode flies the selected course through the active waypoint and suspends sequencing', () => {
    const fp = new FlightPlanner(long());
    fp.activateLeg(3);
    const wp = fp.waypoints[3].position;
    fp.setObs(45);
    expect(fp.obsCourseDeg).toBe(45);
    // 2 km right of the 045° course line through the waypoint, 5 km before it
    const onCourse = destinationPoint(wp, 225, 5000);
    const right = destinationPoint(onCourse, 135, 2000);
    let s = fp.update(right, GS)!;
    expect(s.obsCourseDeg).toBe(45);
    expect(s.desiredTrackDeg).toBe(45);
    expect(s.crossTrackM).toBeGreaterThan(1500);
    // passing the waypoint does not sequence
    s = fp.update(destinationPoint(wp, 45, 3000), GS)!;
    expect(s.activeLeg).toBe(3);
    fp.setObs(null);
    s = fp.update(destinationPoint(wp, 90, 3000), GS)!; // past WP03 on the 090° leg
    expect(s.activeLeg).toBeGreaterThan(3);
    expect(s.obsCourseDeg).toBeNull();
  });
});

describe('FlightPlanner editing: review follow-ups', () => {
  const W = (id: string, p: Geodetic, type: Waypoint['type'] = 'user'): Waypoint => ({ id, position: p, type });

  it('a waypoint inserted into the active leg (between FROM and TO) becomes the active waypoint', () => {
    const a = W('A', KSFO), b = W('B', destinationPoint(KSFO, 90, 40_000)), c = W('C', destinationPoint(KSFO, 90, 80_000));
    const fp = new FlightPlanner([a, b, c]);
    expect(fp.activeWaypoint).toBe(b);
    const x = W('X', destinationPoint(KSFO, 60, 20_000));
    fp.insert(1, x); // before B: the plan is now A → X → B → C and the aircraft flies A → X first
    expect(fp.activeWaypoint).toBe(x);
    expect(fp.legOrigin()).toBe(a.position);
    const s = fp.update(destinationPoint(KSFO, 80, 5_000), GS)!;
    expect(s.waypoints[s.activeLeg].id).toBe('X');
    expect(s.desiredTrackDeg).toBeCloseTo(initialBearingDeg(a.position, x.position), 0);
    // inserting before an earlier waypoint, or after the active one, keeps the active waypoint
    fp.insert(0, W('P', destinationPoint(KSFO, 270, 10_000)));
    expect(fp.activeWaypoint).toBe(x);
    fp.insert(3, W('Y', destinationPoint(KSFO, 80, 30_000)));
    expect(fp.activeWaypoint).toBe(x);
    // during a direct-to the leg starts at the D→ origin, so the D→ target stays active
    const fp2 = new FlightPlanner([a, b, c]);
    fp2.directTo(2, KSFO);
    fp2.insert(2, W('Z', destinationPoint(KSFO, 90, 60_000)));
    expect(fp2.activeWaypoint).toBe(c);
    expect(fp2.isDirectTo).toBe(true);
  });

  it('direct-to a duplicated ident (round trip) picks the occurrence ahead, or the very waypoint object given', () => {
    const h0 = W('KHAF', KHAF, 'airport'), s = W('KSFO', KSFO, 'airport'), o = W('KOAK', destinationPoint(KSFO, 50, 17_000), 'airport');
    const h1 = W('KHAF', KHAF, 'airport'); // the destination: same airport as the departure
    const fp = new FlightPlanner([h0, s, o, h1]);
    expect(fp.activeLeg).toBe(1);
    // typed ident (a fresh waypoint object): the KHAF still ahead of the aircraft, not the departure
    expect(fp.directToWaypoint(W('KHAF', KHAF, 'airport'), KSFO)).toBe('in-plan');
    expect(fp.activeLeg).toBe(3);
    // the plan's own waypoint object (FPL cursor → D→) is used as is, wherever it sits
    fp.activateLeg(2);
    expect(fp.directToWaypoint(h0, KSFO)).toBe('in-plan');
    expect(fp.activeLeg).toBe(0);
    expect(fp.directToWaypoint(h1, KSFO)).toBe('in-plan');
    expect(fp.activeLeg).toBe(3);
    // only behind the aircraft: the first one
    const fp2 = new FlightPlanner([h0, s, o]);
    fp2.activateLeg(2);
    fp2.directToWaypoint(W('KHAF', KHAF, 'airport'), KSFO);
    expect(fp2.activeLeg).toBe(0);
  });
});
