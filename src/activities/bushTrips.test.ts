import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/events';
import { FT, KT, NM } from '../core/units';
import { destinationPoint, greatCircleDistance, initialBearingDeg } from '../geo/wgs84';
import { WEATHER_PRESETS } from '../sky/presets';
import { ActivityRunner } from './ActivityRunner';
import { FakeHost, ScriptedAircraft, compactAirport, dataAirport, inputsWith, recordActivityEvents } from './activityTestKit';
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

// ───────────────────────────── flying the legs with the runner ─────────────────────────────

class MemoryStorage implements KeyValueStorage {
  readonly m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
}

const M_PER_FT = FT;
const TAN3 = Math.tan(3 * D2R);

/** The runway end at `icao` most into the preset wind. */
function arrivalEnd(icao: string, windFromDeg: number) {
  const ap = dataAirport(icao);
  const ends = ap.runways.filter((r) => r.surface === 'asphalt').flatMap((r) => runwayEnds(ap, r));
  return ends.sort((a, b) => Math.cos((windFromDeg - b.headingDeg) * D2R) - Math.cos((windFromDeg - a.headingDeg) * D2R))[0];
}

/**
 * A scripted bush pilot: takeoff roll, climb, landmark to landmark at the cruise altitude with a
 * 3° descent profile to a 3 nm final, straight-in approach, flare, rollout to a stop.
 */
function bushPilot(trip: BushTrip, legIndex: number) {
  const leg = trip.legs[legIndex];
  const depEnd = dataAirport(leg.from).runways.flatMap((r) => runwayEnds(dataAirport(leg.from), r)).find((e) => e.ident === leg.departureRunway)!;
  const arr = arrivalEnd(leg.to, WEATHER_PRESETS[leg.weather ?? 'few'].winds[0].directionDeg);
  const faf = destinationPoint(arr.threshold, arr.headingDeg + 180, 3 * NM);
  const aimM = arr.displacedM + 150;
  const start = destinationPoint(depEnd.threshold, depEnd.headingDeg, depEnd.displacedM + 30);
  const ac = new ScriptedAircraft({ lat: start.lat, lon: start.lon, altFt: depEnd.threshold.alt / M_PER_FT, groundFt: depEnd.threshold.alt / M_PER_FT, hdgTrue: depEnd.headingDeg, iasKt: 0, onGround: true });
  ac.inputs.throttle = 1;
  let phase: 'roll' | 'nav' | 'final' | 'rollout' = 'roll';
  let next = 0;
  const policy = (a: ScriptedAircraft, dt: number) => {
    const here = { lat: a.lat, lon: a.lon, alt: 0 };
    if (phase === 'roll') {
      a.iasKt += 6 * dt;
      if (a.iasKt >= 60) { phase = 'nav'; a.onGround = false; a.vsFpm = 700; a.pitchDeg = 8; a.altFt += 1; }
      return;
    }
    if (phase === 'nav') {
      if (greatCircleDistance(here, geo(depEnd.threshold)) > 3 * NM) a.groundFt = 0;
      a.iasKt = 100;
      const wp = next < leg.waypoints.length ? leg.waypoints[next] : null;
      const target = wp ? geo(wp) : faf;
      const dist = greatCircleDistance(here, target);
      if (wp && dist < 0.8 * NM) next++;
      const toFafNm = (dist + (wp ? greatCircleDistance(target, faf) : 0)) / NM;
      const fafFt = (arr.threshold.alt + (3 * NM + aimM) * TAN3) / M_PER_FT;
      a.steer({ magHdgDeg: initialBearingDeg(here, target), altFt: Math.min(leg.cruiseFt, fafFt + toFafNm * NM * TAN3 / M_PER_FT), maxBankDeg: 20, maxVsFpm: 800 });
      if (!wp && dist < 0.6 * NM) {
        // established: on the extended centreline at the FAF (a short, harmless reposition)
        phase = 'final';
        a.lat = faf.lat; a.lon = faf.lon; a.hdgTrue = arr.headingDeg; a.bankDeg = 0; a.iasKt = 65; a.flapDeg = 30;
        a.groundFt = arr.threshold.alt / M_PER_FT;
      }
      return;
    }
    if (phase === 'final') {
      const toAimM = greatCircleDistance(here, geo(arr.threshold)) * Math.sign(Math.cos((initialBearingDeg(here, geo(arr.threshold)) - arr.headingDeg) * D2R)) + aimM;
      const wantFt = (arr.threshold.alt + Math.max(toAimM, 0) * TAN3) / M_PER_FT;
      a.vsFpm = -a.iasKt * KT * TAN3 * 196.85 + (wantFt - a.altFt) * 3;
      if (a.aglFt < 20) a.vsFpm = Math.max(a.vsFpm, -150);
      if (a.altFt + (a.vsFpm / 60) * dt <= a.groundFt) { phase = 'rollout'; a.onGround = true; a.altFt = a.groundFt; a.vsFpm = 0; a.inputs.throttle = 0; }
      return;
    }
    a.iasKt = Math.max(0, a.iasKt - 5 * dt);
  };
  return { ac, policy, arr, get phase() { return phase; } };
}

/** Fly one leg through the runner with a TouchdownDetector scoring the landing, like the simulator does. */
async function flyLeg(trip: BushTrip, legIndex: number, store: ProgressStore) {
  const events = new EventBus();
  const host = new FakeHost();
  const runner = new ActivityRunner({ host, events, progress: store });
  const rec = recordActivityEvents(events);
  const landings: string[] = [];
  events.on('landing:scored', (e) => landings.push(String(e.details.runway)));
  const leg = trip.legs[legIndex];
  const td = new TouchdownDetector(events, { airports: () => [dataAirport(leg.from), dataAirport(leg.to)] });
  await runner.start(bushLegActivity(trip, legIndex));
  const pilot = bushPilot(trip, legIndex);
  td.reset(true);
  const dt = 0.25;
  let t = 0;
  while (runner.phase === 'running' && t < 4 * 3600) {
    pilot.policy(pilot.ac, dt);
    pilot.ac.step(dt);
    const s = pilot.ac.state();
    td.step(dt, s);
    runner.update(dt, s, pilot.ac.inputs);
    t += dt;
  }
  runner.dispose();
  return { runner, host, rec, landings, arr: pilot.arr, t };
}

describe('bush trip legs flown through the ActivityRunner', () => {
  it('a scripted pilot completes every leg in order; progress unlocks the next leg each time', async () => {
    const storage = new MemoryStorage();
    const trip = PACIFIC_COAST;
    for (let i = 0; i < trip.legs.length; i++) {
      const store = new ProgressStore(storage);
      expect(store.isLegUnlocked(trip.id, i)).toBe(true);
      if (i + 1 < trip.legs.length) expect(store.isLegUnlocked(trip.id, i + 1)).toBe(false);
      expect(store.nextLeg(trip.id, trip.legs.length)).toBe(i);
      const { runner, host, rec, landings, arr } = await flyLeg(trip, i, store);
      const r = runner.result!;
      expect(r.success, `leg ${i + 1}: ${r.summary}`).toBe(true);
      expect(r.kind).toBe('bushTrip');
      expect(r.id).toBe(legActivityId(trip.id, i));
      expect(host.calls[0]).toBe(`weather ${trip.legs[i].weather}`);
      expect(host.calls[1]).toBe(`spawnAtRunway ${trip.legs[i].from} ${trip.legs[i].departureRunway}`);
      expect(host.calls).toContain(`route ${trip.legs[i].waypoints.length + 2}`);
      expect(host.calls[host.calls.length - 1]).toBe('clearRoute');
      // every landmark passed and announced exactly once, the landing scored on the destination runway
      for (const w of trip.legs[i].waypoints) expect(rec.of('activity:instruction').filter((x) => x.text.startsWith(`${w.name}. Next:`)).length, w.name).toBe(1);
      expect(landings).toEqual([`${trip.legs[i].to} ${arr.ident}`]);
      expect(r.landingScore).toBeGreaterThan(5000);
      expect(r.steps.every((s) => s.completed)).toBe(true);
      expect(rec.of('activity:started').length).toBe(1);
      expect(rec.of('activity:finished')).toEqual([{ id: r.id, success: true, score: r.score, summary: r.summary }]);
      expect(r.score).toBeGreaterThanOrEqual(75);
      expect(store.isLegCompleted(trip.id, i)).toBe(true);
      expect(store.leg(trip.id, i)).toMatchObject({ attempts: 1, bestLandingScore: r.landingScore });
    }
    const done = new ProgressStore(storage);
    expect(done.nextLeg(trip.id, trip.legs.length)).toBe(trip.legs.length);
    expect(done.completedLegs(trip.id)).toBe(trip.legs.length);
    expect(tripById(trip.id)).toBe(trip);
  });
});

describe('bush trip leg: wrong airport, restart and crash', () => {
  it('stopping at the wrong field coaches instead of completing; a reset at the departure restarts; a crash fails the leg', async () => {
    const storage = new MemoryStorage();
    const store = new ProgressStore(storage);
    const trip = PACIFIC_COAST;
    const events = new EventBus();
    const host = new FakeHost();
    const runner = new ActivityRunner({ host, events, progress: store });
    const rec = recordActivityEvents(events);
    await runner.start(bushLegActivity(trip, 0));
    const pilot = bushPilot(trip, 0);
    const fly = (seconds: number, dt = 0.25) => {
      for (let t = 0; t < seconds && runner.running; t += dt) { pilot.policy(pilot.ac, dt); pilot.ac.step(dt); runner.update(dt, pilot.ac.state(), pilot.ac.inputs); }
    };
    fly(90);
    expect(runner.step?.id).toBe('enroute');
    const landing = () => runner.objectives.find((o) => o.label === 'Land at KRHV')!;
    const stopAt = () => runner.objectives.find((o) => o.label.startsWith('Land and stop at'))!;

    // back on the ground at Half Moon Bay: a scored landing there is ignored, the stop is not the destination
    const haf = destinationPoint(geo(dataAirport('KHAF').position), 0, 100);
    Object.assign(pilot.ac, { lat: haf.lat, lon: haf.lon, altFt: 66, groundFt: 66, onGround: true, iasKt: 0, vsFpm: 0, bankDeg: 0 });
    events.emit('landing:scored', { score: 7000, details: { runway: 'KHAF 30', grade: 'Good', touchdownFromThresholdM: 400 } });
    const before = rec.log.length;
    for (let t = 0; t < 30; t += 0.25) runner.update(0.25, pilot.ac.state(), pilot.ac.inputs);
    expect(runner.running).toBe(true);
    expect(landing().state).toBe('active');
    expect(stopAt().state).toBe('active');
    const wrong = rec.log.slice(before).filter((e) => e.name === 'activity:instruction' && (e.payload as { text: string }).text.startsWith("This isn't Reid-Hillview"));
    expect(wrong.length).toBeGreaterThanOrEqual(1);
    expect(wrong.length).toBeLessThanOrEqual(2); // bounded: at most one per repeat interval (20 s)

    // the pilot restarts the flight at the departure: the leg starts over without finishing
    events.emit('flight:reset', { spawn: { geo: { lat: 37.509, lon: -122.496, alt: 11 }, headingRad: 317 * D2R, speedMs: 0, onGround: true, engineRunning: true } });
    expect(runner.running).toBe(true);
    expect(runner.stepIndex).toBe(0);
    expect(rec.of('activity:finished').length).toBe(0);
    expect(rec.of('activity:instruction').filter((x) => x.text.startsWith('Leg 1: Half Moon Bay to Reid-Hillview')).length).toBe(2);
    expect(host.calls.filter((c) => c === 'route 4').length).toBe(2); // the reset cleared the flight plan: reloaded

    // a crash ends it: not completed, the next leg stays locked, the attempt is counted once
    events.emit('aircraft:crash', { reason: 'terrain impact' });
    events.emit('aircraft:crash', { reason: 'terrain impact' });
    expect(runner.phase).toBe('finished');
    const fin = rec.of('activity:finished');
    expect(fin.length).toBe(1);
    expect(fin[0].success).toBe(false);
    expect(runner.result?.reason).toBe('Crash: terrain impact');
    expect(store.isLegCompleted(trip.id, 0)).toBe(false);
    expect(store.isLegUnlocked(trip.id, 1)).toBe(false);
    expect(store.leg(trip.id, 0)?.attempts).toBe(1);
    expect(new ProgressStore(storage).nextLeg(trip.id, trip.legs.length)).toBe(0);
  });

  it('a reset far from the departure abandons the leg', async () => {
    const events = new EventBus();
    const runner = new ActivityRunner({ host: new FakeHost(), events, progress: null });
    const rec = recordActivityEvents(events);
    await runner.start(bushLegActivity(PACIFIC_COAST, 3));
    events.emit('flight:reset', { spawn: { geo: { lat: 37.6, lon: -122.4, alt: 4 }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: true } });
    expect(rec.of('activity:finished')).toMatchObject([{ success: false }]);
    expect(runner.result?.reason).toBe('Flight changed');
  });

  it('builds the leg activity with fuel carried over and the briefing in the first instruction', () => {
    const def = bushLegActivity(PACIFIC_COAST, 1, { fuelFraction: 0.62 });
    expect(def.setup).toMatchObject({ spawn: 'runway', icao: 'KRHV', runway: '31R', fuelFraction: 0.62, weather: 'scattered' });
    expect(def.trip).toEqual({ tripId: 'pacific-coast', legIndex: 1 });
    expect(def.steps.map((s) => s.id)).toEqual(['depart', 'enroute']);
    expect(def.steps[0].instruction.text).toContain('Highest terrain near the route: Loma Prieta, 3,786 ft.');
    expect(def.steps[0].instruction.speech).toContain('five thousand five hundred feet');
    expect(bushLegActivity(PACIFIC_COAST, 0, { fuelFraction: 0 }).setup).toMatchObject({ fuelFraction: 0.05 });
    expect(() => bushLegActivity(PACIFIC_COAST, 99)).toThrow();
  });
});

describe('bush trip leg: departure reminder', () => {
  it('power against a set parking brake gets one reminder, nothing else is coached on the departure', async () => {
    const events = new EventBus();
    const runner = new ActivityRunner({ host: new FakeHost(), events });
    const rec = recordActivityEvents(events);
    await runner.start(bushLegActivity(PACIFIC_COAST, 0));
    const s = flyStateOnGround();
    const brake = inputsWith({ parkingBrake: true, throttle: 1 });
    for (let t = 0; t < 30; t += 0.1) runner.update(0.1, s, brake);
    const said = rec.of('activity:instruction').map((x) => x.text);
    expect(said.filter((x) => x === 'Parking brake is set: release it to roll.').length).toBe(1);
    expect(said.length).toBe(2); // the briefing and the reminder
  });
});

function flyStateOnGround() {
  const ac = new ScriptedAircraft({ lat: 37.509, lon: -122.496, altFt: 36, groundFt: 36, hdgTrue: 317, iasKt: 0, onGround: true });
  return ac.state();
}
