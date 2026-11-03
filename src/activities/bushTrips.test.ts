import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/events';
import { FT, KT, NM } from '../core/units';
import { destinationPoint, greatCircleDistance, initialBearingDeg } from '../geo/wgs84';
import { WEATHER_PRESETS } from '../sky/presets';
import { ActivityRunner } from './ActivityRunner';
import { FakeHost, ScriptedAircraft, compactAirport, dataAirport, drive, recordActivityEvents } from './activityTestKit';
import {
  BUSH_TRIPS, PACIFIC_COAST, WAYPOINT_RADIUS_M, bushLegActivity, legActivityId, legDistanceNm, legRoute, legRouteNm, navLog, tripById,
  type BushTrip,
} from './bushTrips';
import { ProgressStore, type KeyValueStorage } from './progressStore';
import { runwayEnds } from './runwayFrame';
import { TouchdownDetector } from './TouchdownDetector';

const R = 6371000;
const D2R = Math.PI / 180;
const geo = (p: { lat: number; lon: number }) => ({ lat: p.lat, lon: p.lon, alt: 0 });

/** Signed cross-track (+ right) and along-track distance of p from the great circle a→b, m. */
function trackOffsets(a: { lat: number; lon: number }, b: { lat: number; lon: number }, p: { lat: number; lon: number }): { xt: number; at: number } {
  const d13 = greatCircleDistance(geo(a), geo(p)) / R;
  const t13 = initialBearingDeg(geo(a), geo(p)) * D2R;
  const t12 = initialBearingDeg(geo(a), geo(b)) * D2R;
  const xt = Math.asin(Math.sin(d13) * Math.sin(t13 - t12));
  const at = Math.acos(Math.min(1, Math.cos(d13) / Math.cos(xt))) * Math.sign(Math.cos(t13 - t12));
  return { xt: xt * R, at: at * R };
}

const legsOf = (trip: BushTrip) => trip.legs.map((leg, i) => ({ leg, i, dep: trip.airports[leg.from], dest: trip.airports[leg.to] }));

describe('bush trip data matches public/data', () => {
  it('every airport exists as a small or medium airport at the stated position and elevation', () => {
    for (const trip of BUSH_TRIPS) {
      for (const [icao, a] of Object.entries(trip.airports)) {
        expect(a.icao).toBe(icao);
        const c = compactAirport(icao);
        expect(c, icao).toBeDefined();
        if (!c) continue;
        expect(['S', 'M'], `${icao} type`).toContain(c.t);
        expect(greatCircleDistance(geo(a), { lat: c.la, lon: c.lo, alt: 0 }), `${icao} position`).toBeLessThan(50);
        expect(Math.abs(a.elevM - c.e), `${icao} elevation`).toBeLessThan(1);
        expect((c.r ?? []).length, `${icao} runways`).toBeGreaterThan(0);
      }
    }
  });

  it('every departure runway exists at its airport, is paved and long enough for a 172', () => {
    for (const trip of BUSH_TRIPS) {
      for (const { leg, dep } of legsOf(trip)) {
        const ap = dataAirport(dep.icao);
        const end = ap.runways.flatMap((r) => runwayEnds(ap, r)).find((e) => e.ident === leg.departureRunway);
        expect(end, `${dep.icao} ${leg.departureRunway}`).toBeDefined();
        expect(end!.runway.surface).toBe('asphalt');
        expect(end!.lengthM - end!.displacedM).toBeGreaterThan(700);
      }
    }
  });

  it('departure runways face into the preset surface wind (no tailwind on the takeoff roll)', () => {
    for (const trip of BUSH_TRIPS) {
      for (const { leg, dep } of legsOf(trip)) {
        const ap = dataAirport(dep.icao);
        const end = ap.runways.flatMap((r) => runwayEnds(ap, r)).find((e) => e.ident === leg.departureRunway)!;
        const w = WEATHER_PRESETS[leg.weather ?? 'few'].winds[0];
        const headwindKt = w.speedKt * Math.cos((w.directionDeg - end.headingDeg) * D2R);
        const crossKt = Math.abs(w.speedKt * Math.sin((w.directionDeg - end.headingDeg) * D2R));
        expect(headwindKt, `${dep.icao} ${leg.departureRunway}`).toBeGreaterThan(0);
        expect(crossKt, `${dep.icao} ${leg.departureRunway}`).toBeLessThan(10);
      }
    }
  });
});

describe('bush trip geometry', () => {
  it('has at least 6 consecutive legs, each 15-45 nm direct and 15-45 nm through its landmarks', () => {
    for (const trip of BUSH_TRIPS) {
      expect(trip.legs.length).toBeGreaterThanOrEqual(6);
      for (const { leg, i } of legsOf(trip)) {
        if (i > 0) expect(leg.from).toBe(trip.legs[i - 1].to);
        expect(leg.from).not.toBe(leg.to);
        const direct = legDistanceNm(trip, i), route = legRouteNm(trip, i);
        expect(direct, `leg ${i + 1} direct`).toBeGreaterThanOrEqual(15);
        expect(direct, `leg ${i + 1} direct`).toBeLessThanOrEqual(45);
        expect(route, `leg ${i + 1} route`).toBeLessThanOrEqual(45);
        expect(route / direct, `leg ${i + 1} detour`).toBeLessThan(1.6);
      }
    }
  });

  it('1-3 landmarks per leg, each within 12 nm of the direct course, between the airports and in flying order', () => {
    for (const trip of BUSH_TRIPS) {
      const ids = new Set<string>();
      for (const { leg, i, dep, dest } of legsOf(trip)) {
        expect(leg.waypoints.length).toBeGreaterThanOrEqual(1);
        expect(leg.waypoints.length).toBeLessThanOrEqual(3);
        const L = greatCircleDistance(geo(dep), geo(dest));
        let prevAt = 0;
        for (const w of leg.waypoints) {
          expect(w.id, 'flight-plan ident').toMatch(/^[A-Z]{3,6}$/);
          expect(ids.has(w.id), `duplicate ${w.id}`).toBe(false);
          ids.add(w.id);
          const { xt, at } = trackOffsets(dep, dest, w);
          expect(Math.abs(xt) / NM, `leg ${i + 1} ${w.name} cross-track`).toBeLessThanOrEqual(12);
          expect(at, `leg ${i + 1} ${w.name} along-track`).toBeGreaterThan(prevAt);
          expect(at, `leg ${i + 1} ${w.name} along-track`).toBeLessThan(L);
          // far enough from both airports to be a navigation point of its own
          expect(greatCircleDistance(geo(dep), geo(w)), `${w.name} vs departure`).toBeGreaterThan(WAYPOINT_RADIUS_M + 1000);
          expect(greatCircleDistance(geo(w), geo(dest)), `${w.name} vs destination`).toBeGreaterThan(WAYPOINT_RADIUS_M + 1000);
          prevAt = at;
        }
      }
    }
  });

  it('suggested cruise altitudes clear the highest terrain near the route by 1,000 ft', () => {
    for (const trip of BUSH_TRIPS) {
      for (const { leg, i, dep, dest } of legsOf(trip)) {
        expect(leg.cruiseFt % 500, `leg ${i + 1}`).toBe(0);
        expect(leg.cruiseFt - leg.terrain.ft, `leg ${i + 1} over ${leg.terrain.name}`).toBeGreaterThanOrEqual(1000);
        expect(leg.terrain.ft, 'terrain is at least as high as the airports').toBeGreaterThanOrEqual(Math.max(dep.elevM, dest.elevM) / FT);
      }
    }
    // the ridge everyone remembers: Loma Prieta (3,786 ft) on leg 2
    expect(PACIFIC_COAST.legs[1].waypoints[0].name).toBe('Loma Prieta');
    expect(PACIFIC_COAST.legs[1].cruiseFt).toBeGreaterThanOrEqual(3786 + 1000);
  });

  it('nav log and route agree; the route carries the cruise altitude', () => {
    const trip = PACIFIC_COAST;
    for (let i = 0; i < trip.legs.length; i++) {
      const log = navLog(trip, i);
      expect(log.length).toBe(trip.legs[i].waypoints.length + 1);
      expect(log.reduce((s, e) => s + e.distanceNm, 0)).toBeCloseTo(legRouteNm(trip, i), 6);
      for (const e of log) expect(e.trueCourseDeg).toBeGreaterThanOrEqual(0);
      const route = legRoute(trip, i);
      expect(route.length).toBe(trip.legs[i].waypoints.length + 2);
      expect(route[0]).toMatchObject({ id: trip.legs[i].from, type: 'airport' });
      expect(route[route.length - 1]).toMatchObject({ id: trip.legs[i].to, type: 'airport' });
      for (const w of route.slice(1, -1)) {
        expect(w.type).toBe('user');
        expect(w.altConstraintM).toBeCloseTo(trip.legs[i].cruiseFt * FT, 6);
      }
    }
  });

  it('speech lines are spelled for text-to-speech (no digits)', () => {
    for (const trip of BUSH_TRIPS) {
      for (let i = 0; i < trip.legs.length; i++) {
        const def = bushLegActivity(trip, i);
        const lines = [trip.legs[i].briefing, ...def.steps.flatMap((s) => [s.instruction, s.success, ...s.objectives.map((o) => o.doneLine)]), def.debrief?.pass, def.debrief?.fail];
        for (const l of lines) if (l?.speech) expect(l.speech, l.speech).not.toMatch(/\d/);
      }
    }
  });
});
