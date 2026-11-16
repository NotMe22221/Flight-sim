import { describe, expect, it } from 'vitest';
import { C172_PATTERN, CUB_PATTERN, PatternAircraft, type PatternContext, type PatternLeg, type PatternRunway } from './pattern';

const RWY: PatternRunway = { lat: 37.6, lon: -122.4, elevM: 4, headingDeg: 280, lengthM: 2300, endElevM: 5, side: 'left' };
const free: PatternContext = { runwayOccupied: () => false, sequenceBusy: () => false };

function fly(a: PatternAircraft, seconds: number, ctx: PatternContext = free, dt = 0.1, each?: (a: PatternAircraft, t: number) => void) {
  for (let t = 0; t < seconds; t += dt) { a.update(dt, ctx); each?.(a, t); }
}

describe('PatternAircraft', () => {
  for (const [name, perf] of [['C172', C172_PATTERN], ['Cub', CUB_PATTERN]] as const) {
    it(`${name}: flies complete circuits through every leg, inside the pattern, touching down on the runway`, () => {
      const a = new PatternAircraft('a', 'N1', name, perf, RWY, { leg: 'takeoff', along: 0 });
      const seen = new Set<PatternLeg>();
      let landings = 0, prev = a.leg;
      fly(a, 1200, free, 0.1, (ac) => {
        seen.add(ac.leg);
        expect(Number.isFinite(ac.x) && Number.isFinite(ac.y) && Number.isFinite(ac.h)).toBe(true);
        expect(Math.abs(ac.y)).toBeLessThan(2200); // left traffic: never far outside the downwind
        expect(ac.h).toBeLessThan(1000 * 0.3048 + 40); // never far above pattern altitude
        if (ac.onGround) { expect(ac.x).toBeGreaterThan(-60); expect(ac.x).toBeLessThan(RWY.lengthM); expect(Math.abs(ac.y)).toBeLessThan(30); }
        if (prev !== 'landing' && ac.leg === 'landing') landings++;
        prev = ac.leg;
      });
      for (const l of ['takeoff', 'upwind', 'crosswind', 'downwind', 'base', 'final', 'landing'] as PatternLeg[]) expect(seen.has(l), l).toBe(true);
      expect(landings).toBeGreaterThanOrEqual(2); // 20 min: several touch-and-goes (a circuit is ~5-7 min)
    });
  }

  it('left traffic stays left of the runway, right traffic right', () => {
    const l = new PatternAircraft('l', 'N1', 'C172', C172_PATTERN, RWY, { leg: 'downwind', along: 0.5 });
    const r = new PatternAircraft('r', 'N2', 'C172', C172_PATTERN, { ...RWY, side: 'right' }, { leg: 'downwind', along: 0.5 });
    expect(l.y).toBeLessThan(0); expect(r.y).toBeGreaterThan(0);
    // left traffic: the first turn after take-off is to the left (track goes negative)
    const t = new PatternAircraft('t', 'N3', 'C172', C172_PATTERN, RWY, { leg: 'upwind', along: 0.95 });
    fly(t, 30);
    expect(t.trk).toBeLessThan(-20);
  });

  it('extends the downwind while the sequence is busy, then turns base when it clears', () => {
    const a = new PatternAircraft('a', 'N1', 'C172', C172_PATTERN, RWY, { leg: 'downwind', along: 0.9 });
    let busy = true;
    const ctx: PatternContext = { runwayOccupied: () => false, sequenceBusy: () => busy };
    fly(a, 60, ctx);
    expect(a.leg).toBe('downwind');
    expect(a.extending).toBe(true);
    expect(a.x).toBeLessThan(a.circuit.downwindEndX - 500);
    busy = false;
    fly(a, 20, ctx);
    expect(['base', 'final']).toContain(a.leg);
  });

  it('goes around from short final when the runway is occupied, then rejoins the circuit', () => {
    const a = new PatternAircraft('a', 'N1', 'C172', C172_PATTERN, RWY, { leg: 'final', along: 0.6 });
    let occupied = true;
    const ctx: PatternContext = { runwayOccupied: () => occupied, sequenceBusy: () => false };
    let wentAround = false, minH = Infinity;
    fly(a, 40, ctx, 0.1, (ac) => { if (ac.leg === 'goaround') wentAround = true; if (wentAround) minH = Math.min(minH, ac.h); });
    expect(wentAround).toBe(true);
    expect(a.onGround).toBe(false);
    expect(minH).toBeGreaterThan(5); // never touched the occupied runway
    occupied = false;
    fly(a, 120, ctx);
    expect(['upwind', 'goaround', 'crosswind', 'downwind']).toContain(a.leg);
  });

  it('geodetic output follows the runway: the threshold at x=0, the far end along the true heading', () => {
    const a = new PatternAircraft('a', 'N1', 'C172', C172_PATTERN, RWY, { leg: 'landing', along: 0 });
    a.x = 0; a.y = 0;
    const g0 = { ...a.geodetic() };
    expect(g0.lat).toBeCloseTo(RWY.lat, 6); expect(g0.lon).toBeCloseTo(RWY.lon, 6); expect(g0.alt).toBeCloseTo(RWY.elevM, 3);
    a.x = RWY.lengthM;
    const g1 = a.geodetic();
    const dN = (g1.lat - g0.lat) * 111320, dE = (g1.lon - g0.lon) * 111320 * Math.cos(RWY.lat * Math.PI / 180);
    expect(Math.hypot(dN, dE)).toBeCloseTo(RWY.lengthM, -1);
    expect(((Math.atan2(dE, dN) * 180) / Math.PI + 360) % 360).toBeCloseTo(280, 0);
    expect(g1.alt).toBeCloseTo(RWY.endElevM, 3);
  });

  it('is deterministic', () => {
    const run = () => { const a = new PatternAircraft('a', 'N1', 'C172', C172_PATTERN, RWY, { leg: 'crosswind', along: 0.3 }); fly(a, 300); return [a.x, a.y, a.h, a.leg]; };
    expect(run()).toEqual(run());
  });
});

describe('PatternAircraft on the ground', () => {
  // stand 300 m beside the runway, taxi path out to a hold-short point 70 m left of the centre line near the threshold
  const path: [number, number][] = [[600, -300], [600, -150], [200, -150], [60, -150], [60, -70]];

  it('taxis from a stand to the hold-short point, holds while the runway is busy, lines up and takes off', () => {
    const a = new PatternAircraft('d', 'N9', 'C172', C172_PATTERN, RWY, { leg: 'downwind', along: 0 });
    a.parkAt(600, -300, 90, path, 5);
    let busy = true;
    const ctx: PatternContext = { runwayOccupied: () => busy, sequenceBusy: () => false };
    const seen: string[] = [];
    let maxTaxiKt = 0;
    fly(a, 300, ctx, 0.1, (ac) => {
      if (seen[seen.length - 1] !== ac.leg) seen.push(ac.leg);
      if (ac.leg === 'taxi') { maxTaxiKt = Math.max(maxTaxiKt, ac.v / 0.514444); expect(ac.onGround).toBe(true); expect(ac.y).toBeLessThan(-40); }
    });
    expect(seen.slice(0, 3)).toEqual(['parked', 'taxi', 'holding']);
    expect(a.leg).toBe('holding'); // still holding: the runway is busy
    expect(Math.hypot(a.x - 60, a.y + 70)).toBeLessThan(10);
    expect(maxTaxiKt).toBeLessThan(20);
    busy = false;
    fly(a, 120, ctx, 0.1, (ac) => { if (seen[seen.length - 1] !== ac.leg) seen.push(ac.leg); });
    expect(seen).toEqual(expect.arrayContaining(['lineup', 'takeoff', 'upwind']));
    expect(a.onGround).toBe(false);
  });

  it('stops while blocked ahead, a static parked aircraft never moves', () => {
    const a = new PatternAircraft('d', 'N9', 'C172', C172_PATTERN, RWY, { leg: 'downwind', along: 0 });
    a.parkAt(600, -300, 90, path, 0);
    const ctx: PatternContext = { runwayOccupied: () => false, sequenceBusy: () => false, blockedAhead: () => true };
    fly(a, 60, ctx);
    expect(a.leg).toBe('taxi');
    expect(Math.hypot(a.x - 600, a.y + 300)).toBeLessThan(3);
    const s = new PatternAircraft('s', 'N8', 'C172', C172_PATTERN, RWY, { leg: 'downwind', along: 0 });
    s.parkAt(700, -320, 0, null);
    fly(s, 600);
    expect(s.leg).toBe('parked'); expect(s.x).toBe(700); expect(s.y).toBe(-320);
  });
});

describe('PatternAircraft arrivals', () => {
  it('flies a straight-in, lands to a full stop, exits, taxis in, parks and later departs again', () => {
    const a = new PatternAircraft('a', 'N7', 'C172', C172_PATTERN, RWY, { leg: 'downwind', along: 0 });
    const inPath: [number, number][] = [[900, 0], [900, -80], [700, -200], [600, -300]];
    const outPath: [number, number][] = [[600, -300], [600, -150], [60, -150], [60, -70]];
    a.arrive(inPath, 90, outPath, 30);
    const seen: string[] = [];
    let minHBeforeLand = Infinity;
    fly(a, 900, free, 0.1, (ac) => {
      if (seen[seen.length - 1] !== ac.leg) seen.push(ac.leg);
      if (ac.leg === 'final') minHBeforeLand = Math.min(minHBeforeLand, ac.h);
      if (ac.leg === 'landing') { expect(ac.x).toBeGreaterThan(0); expect(Math.abs(ac.y)).toBeLessThan(30); }
    });
    expect(seen.slice(0, 4)).toEqual(['final', 'landing', 'taxi', 'parked']);
    // parked at the stand, then out again: taxi → holding → lineup → takeoff → upwind (a departure)
    expect(seen).toEqual(expect.arrayContaining(['holding', 'lineup', 'takeoff', 'upwind']));
    expect(a.departs).toBe(true);
  });

  it('a distant straight-in does not hold up circuit traffic; a close one does', () => {
    const a = new PatternAircraft('a', 'N7', 'C172', C172_PATTERN, RWY, { leg: 'downwind', along: 0 });
    a.arrive([[900, 0], [600, -300]], 0, [], Infinity, 6500);
    expect(a.inSequence).toBe(false);
    a.arrive([[900, 0], [600, -300]], 0, [], Infinity, 2500);
    expect(a.inSequence).toBe(true);
  });
});
