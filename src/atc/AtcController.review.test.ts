/**
 * Regression tests from the adversarial review of the scripted ATC: each one failed before its
 * fix (phraseology vs FAA JO 7110.65 §2-4, state-machine dead ends and stale state).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Airport } from '../core/types';
import { destinationPoint } from '../geo/wgs84';
import type { NavDb } from '../nav';
import { findRunwayEnd, magneticDeclinationDeg } from '../nav';
import { buildAtis } from './atis';
import { makeCallsign } from './callsign';
import { allRunwayRefs, runwaysInUse } from './field';
import { makeRunwayFrame, relativeTo } from './geometry';
import { readback } from './messages';
import { frequency, wind } from './phraseology';
import { Harness, type Frame, type Point } from './__tests__/harness';
import { ksfoWeather, loadBayAreaDb } from './__tests__/fixtures';

const UTC = Date.UTC(2026, 10, 3, 18, 56);
let db: NavDb;

beforeAll(async () => { db = await loadBayAreaDb(); });

function airport(icao: string): Airport {
  const ap = db.getAirport(icao);
  if (!ap) throw new Error(`${icao} missing`);
  return ap;
}

function frameOf(ap: Airport, ident: string): Frame {
  const r = findRunwayEnd(ap, ident);
  if (!r) throw new Error(`${ap.icao} ${ident} missing`);
  return { threshold: r.end.threshold, headingDeg: r.end.headingDeg, elevationM: ap.elevationM };
}

/** Over the ocean WNW of KSFO: KHAF 17.8 nm, KSFO 18.0 nm, KOAK 23.3 nm, no airport within 3 nm. */
const OFFSHORE: Point = { along: 35000, cross: 0, h: 300 };

/** Take off along the frame from near `thr` (a threshold in the frame) and climb straight out (no calls). */
function takeOffStraightOut(h: Harness, climbTo: Point, thr = { along: 0, cross: 0 }): void {
  h.move({ along: thr.along + 700, cross: thr.cross, h: 0 }, 25, true);
  h.move({ along: thr.along + 900, cross: thr.cross, h: 5 }, 30, false);
  h.wait(1.2);
  h.move(climbTo, 45, false, 0.25);
}

describe('phraseology (FAA JO 7110.65 §2-4-17)', () => {
  it('frequencies: digits after the second decimal are not spoken; the subtitle keeps the tuning value', () => {
    expect(frequency(135.275)).toEqual({ text: '135.275', speech: 'one three five point two seven' });
    expect(frequency(118.025).speech).toBe('one one eight point zero two');
    expect(frequency(124.175).speech).toBe('one two four point one seven');
    expect(frequency(126.55).speech).toBe('one two six point five five');
    expect(frequency(121.5).speech).toBe('one two one point five');
  });

  it('surface wind gusts: "wind two seven zero at one five gusts three five"', () => {
    expect(wind(270, 15, 35)).toEqual({ text: '270 at 15 gusts 35', speech: 'two seven zero at one five gusts three five' });
  });
});

describe('destinations chosen from the menu', () => {
  it('an airport 15–30 nm away stays the destination instead of being cancelled at the next tick', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), OFFSHORE, UTC);
    h.setMotion(50, 0, false);
    h.atc.reset(null);
    h.wait(2);
    expect(h.atc.phase).toBe('ENROUTE');
    h.select(/^Prepare to land at San Francisco \(KSFO\)/);
    expect(h.atc.phase).toBe('INBOUND');
    h.wait(5);
    expect(h.atc.phase).toBe('INBOUND');
    expect(h.atc.airportIcao).toBe('KSFO');
    // Calling the tower from there is answered and does not bounce back to en route either.
    h.select(/^Inbound for landing, full stop/);
    h.wait(15);
    expect(h.atc.phase).toBe('PATTERN');
    expect(h.messages.some((m) => /frequency change approved/.test(m.text))).toBe(false);
    // Flying well away from it still abandons the arrival.
    h.move({ along: 90000, cross: 0, h: 300 }, 80, false, 0.5);
    h.wait(12);
    expect(h.atc.phase).toBe('ENROUTE');
  });
});

describe('landings away from the operation', () => {
  it('a touchdown far from every airport is not reported as a landing at the departure field', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 40, cross: 0, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(ksfo);
    h.tick();
    expect(h.atc.phase).toBe('HOLDING_SHORT');
    takeOffStraightOut(h, { along: 9000, cross: 0, h: 400 });
    expect(h.atc.phase).toBe('ENROUTE');
    h.move({ ...OFFSHORE, h: 10 }, 45, false, 0.25);
    h.move({ along: OFFSHORE.along + 300, cross: 0, h: 0 }, 25, true);
    h.move({ along: OFFSHORE.along + 400, cross: 0, h: 0 }, 5, true);
    h.wait(2);
    expect(h.atc.phase).toBe('TAXI_IN');
    expect(h.atc.airportIcao).toBeNull();
    expect(h.messages.some((m) => /exit runway/.test(m.text))).toBe(false);
  });

  it('landing at a towered field without talking to its tower brings no unsolicited tower call', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 40, cross: 0, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(ksfo);
    h.tick();
    takeOffStraightOut(h, { along: 1500, cross: 0, h: 30 });
    expect(h.atc.phase).toBe('DEPARTING');
    h.move({ along: 2000, cross: 0, h: 0 }, 30, true);
    h.move({ along: 2400, cross: 0, h: 0 }, 6, true);
    h.wait(2);
    expect(h.atc.phase).toBe('LANDED');
    expect(h.messages.filter((m) => m.from === 'atc')).toHaveLength(0);
    expect(h.atc.options[0]).toBe('Report clear of runway, request taxi to parking (Ground 121.8)');
  });
});

describe('fields and controllers', () => {
  it('a tower without a ground frequency keeps the arrival instead of sending it to "Ground" on its own frequency', () => {
    const towerOnly: Airport = { ...airport('KHAF'), frequencies: [{ type: 'TWR', mhz: 118.6 }] };
    const h = new Harness(db, ksfoWeather(), frameOf(towerOnly, '30'), { along: 40, cross: 0, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(towerOnly);
    h.tick();
    expect(h.atc.phase).toBe('HOLDING_SHORT');
    h.select(/^Ready for departure, runway 30 \(Tower 118\.6\)/);
    h.wait(3);
    h.select(/^Read back/);
    takeOffStraightOut(h, { along: 1000, cross: 0, h: 15 });
    expect(h.atc.phase).toBe('DEPARTING');
    h.move({ along: 1200, cross: 0, h: 0 }, 30, true);
    h.move({ along: 1400, cross: 0, h: 0 }, 6, true);
    h.wait(2);
    expect(h.atc.phase).toBe('LANDED');
    expect(h.find(/exit runway/)?.text).toBe('Cessna 2FS, exit runway when able, remain this frequency.');
    expect(h.atc.options[0]).toBe('Read back: exit runway');
    h.select(/^Read back: exit runway/);
    expect(h.messages[h.messages.length - 1].text).toBe('Exit runway, Cessna 2FS.');
    expect(h.atc.frequencyMHz).toBe(118.6);
    expect(h.atc.options[0]).toBe('Report clear of runway, request taxi to parking (Tower 118.6)');
  });

  it('the tower does not clear an aircraft to land that is not on its frequency; a report on final gets the clearance', () => {
    const ksfo = airport('KSFO');
    const end28R = findRunwayEnd(ksfo, '28R');
    if (!end28R) throw new Error('28R missing');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 800, cross: -700, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(ksfo);
    h.wait(1);
    h.select(/^Request taxi for closed traffic/);
    h.wait(3);
    h.select(/^Read back: taxi/);
    const rwy = h.atc.runwayIdent ?? '';
    const ref = allRunwayRefs(ksfo).find((r) => r.ident === rwy);
    const r28R = allRunwayRefs(ksfo).find((r) => r.ident === '28R');
    if (!ref || !r28R) throw new Error(`runway ${rwy} missing`);
    const thr = relativeTo(makeRunwayFrame(ksfo, r28R), ref.threshold, 4, 0);
    const p = (along: number, cross: number, hM: number): Point => ({ along: thr.alongM + along, cross: thr.crossM + cross, h: hM });
    // Taxi onto the runway and depart without calling the tower.
    h.move(p(40, 0, 0), 10, true);
    takeOffStraightOut(h, p(3000, 0, 250), { along: thr.alongM, cross: thr.crossM });
    expect(h.atc.phase).toBe('PATTERN');
    h.move(p(3000, -1500, 300), 35, false);
    h.move(p(-1500, -1500, 250), 40, false);
    h.move(p(-1600, 0, 160), 35, false);
    h.move(p(-1000, 0, 100), 35, false);
    expect(h.atc.patternLeg).toBe('final');
    expect(h.atc.landingClearance).toBe('none');
    expect(h.messages.filter((m) => m.from === 'atc' && /cleared to land/.test(m.text))).toHaveLength(0);
    h.select(new RegExp(`^Report final runway ${rwy} \\(Tower 120\\.5\\)`));
    h.wait(3);
    expect(h.find(/cleared to land/)?.text).toBe(`Cessna 2FS, wind 270 at 12 gusts 18, runway ${rwy}, cleared to land.`);
    expect(h.atc.landingClearance).toBe('land');
  });
});

describe('callsigns and ATIS across flights', () => {
  it('select() rejects a non-numeric index instead of throwing', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 800, cross: -700, h: 0 }, UTC);
    h.atc.reset(ksfo);
    h.wait(1);
    expect(h.atc.select(Number.NaN)).toBe(false);
  });

  it('after parking, the next initial call uses the full callsign again', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 40, cross: 0, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(ksfo);
    h.tick();
    h.select(/^Ready for departure/);
    h.wait(3);
    h.select(/^Read back/);
    takeOffStraightOut(h, { along: 1500, cross: 0, h: 30 });
    h.move({ along: 2000, cross: 0, h: 0 }, 30, true);
    h.move({ along: 2400, cross: 0, h: 0 }, 6, true);
    h.wait(2);
    expect(h.atc.phase).toBe('LANDED');
    h.select(/^Read back: exit runway/);
    h.select(/^Report clear of runway/);
    h.wait(3);
    h.select(/^Read back: taxi to parking/);
    expect(h.atc.phase).toBe('TAXI_IN');
    h.setEngine(false);
    h.wait(4);
    expect(h.atc.phase).toBe('PARKED');
    const i = h.select(/^Request taxi for VFR departure/);
    expect(h.messages[i].text).toMatch(/^San Francisco Ground, N172FS, /);
  });

  it('a reset forgets the ATIS letter heard on the previous flight', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 800, cross: -700, h: 0 }, UTC);
    h.atc.reset(ksfo);
    h.wait(1);
    h.select(/^Listen to ATIS/);
    h.atc.reset(ksfo);
    h.wait(1);
    const i = h.select(/^Request taxi for VFR departure/);
    expect(h.messages[i].text).toBe('San Francisco Ground, N172FS, at the ramp, request taxi, VFR departure.');
  });
});

describe('pattern state across operations', () => {
  it('leaving the pattern ends closed traffic: a later takeoff is a departure, not a pattern', () => {
    const khaf = airport('KHAF');
    const h = new Harness(db, ksfoWeather(), frameOf(khaf, '30'), { along: 900, cross: 250, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(khaf);
    h.wait(1);
    h.select(/^Announce taxi to runway 30 for closed traffic/);
    h.move({ along: 40, cross: 0, h: 0 }, 6, true);
    h.wait(3);
    expect(h.atc.phase).toBe('HOLDING_SHORT');
    h.select(/^Announce departing runway 30, remaining in the pattern/);
    takeOffStraightOut(h, { along: 2500, cross: 0, h: 200 });
    expect(h.atc.phase).toBe('PATTERN');
    h.select(/^Announce departing the pattern/);
    expect(h.atc.phase).toBe('ENROUTE');
    // Land straight back on the runway without announcing, then take off again.
    h.move({ along: 3500, cross: 0, h: 150 }, 40, false);
    h.move({ along: 6000, cross: -2500, h: 300 }, 40, false);
    h.move({ along: -3000, cross: -2500, h: 300 }, 40, false);
    h.move({ along: -3000, cross: 0, h: 200 }, 40, false);
    h.move({ along: 150, cross: 0, h: 1 }, 30, false);
    h.move({ along: 200, cross: 0, h: 0 }, 28, true);
    h.wait(0.5);
    expect(h.atc.phase).toBe('LANDED');
    h.move({ along: 700, cross: 0, h: 0 }, 25, true);
    h.move({ along: 900, cross: 0, h: 5 }, 30, false);
    h.wait(1.2);
    expect(h.atc.phase).toBe('DEPARTING');
  });

  it('a short climb correcting a low final is not taken for a go-around', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 40, cross: 0, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(ksfo);
    h.tick();
    h.select(/^Ready for departure/);
    h.wait(3);
    h.select(/^Read back/);
    takeOffStraightOut(h, { along: 1500, cross: 0, h: 60 });
    h.select(/^Request closed traffic/);
    h.wait(3);
    h.select(/^Read back/);
    h.move({ along: 3000, cross: 0, h: 250 }, 35, false);
    h.move({ along: 3000, cross: 1500, h: 300 }, 35, false);
    h.move({ along: -1500, cross: 1500, h: 250 }, 40, false);
    h.move({ along: -1600, cross: 0, h: 160 }, 35, false);
    h.move({ along: -1000, cross: 0, h: 100 }, 35, false);
    expect(h.atc.landingClearance).toBe('land');
    h.select(/^Read back: runway 28R, cleared to land/);
    // Low on the glidepath: climb back up 12 m at ~400 ft/min, then continue the approach.
    h.move({ along: -800, cross: 0, h: 70 }, 35, false);
    h.move({ along: -600, cross: 0, h: 82 }, 35, false);
    h.move({ along: -200, cross: 0, h: 30 }, 35, false);
    expect(h.messages.filter((m) => /go around,/.test(m.text))).toHaveLength(0);
    expect(h.atc.landingClearance).toBe('land');
    h.move({ along: 250, cross: 0, h: 1 }, 32, false);
    h.move({ along: 300, cross: 0, h: 0 }, 30, true);
    h.wait(0.5);
    expect(h.atc.phase).toBe('LANDED');
  });
});

describe('menu labels', () => {
  it('runway designators in labels read like the transmissions (no leading zero)', () => {
    const klvk = airport('KLVK');
    const h = new Harness(db, ksfoWeather(), frameOf(klvk, '07L'), { along: 40, cross: 0, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(klvk);
    h.tick();
    expect(h.atc.phase).toBe('HOLDING_SHORT');
    expect(h.atc.runwayIdent).toBe('07L');
    const i = h.select(/^Ready for departure, runway 7L \(Tower /);
    expect(h.messages[i].text).toMatch(/holding short runway 7L, ready for departure\.$/);
  });

  it('at an untowered field with parallels, the taxi option names the runway the call announces', () => {
    const base = airport('KHAF');
    const rw = base.runways[0];
    const right = (g: { lat: number; lon: number; alt: number }) => destinationPoint(g, rw.headingDeg + 90, 250, g.alt);
    const plain = { threshold: rw.threshold, end: rw.end, headingDeg: rw.headingDeg, lengthM: rw.lengthM, widthM: rw.widthM, surface: rw.surface, lighted: rw.lighted, displacedThresholdM: 0 };
    const parallels: Airport = {
      ...base, frequencies: [],
      runways: [{ ...plain, ident: `${rw.ident}L` }, { ...plain, ident: `${rw.ident}R`, threshold: right(rw.threshold), end: right(rw.end) }],
    };
    expect(allRunwayRefs(parallels).map((r) => r.ident).sort()).toEqual(['12L', '12R', '30L', '30R']);
    const h = new Harness(db, ksfoWeather(), frameOf(parallels, '30L'), { along: 100, cross: -150, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(parallels);
    h.wait(1);
    expect(h.atc.phase).toBe('PARKED');
    h.select(/^Announce taxi to runway 30L for departure \(CTAF 122\.9\)/);
    expect(h.messages[h.messages.length - 1].text).toBe('Half Moon Bay traffic, Cessna 2FS, taxiing to runway 30L, Half Moon Bay.');
    expect(h.atc.runwayIdent).toBe('30L');
  });
});

describe('more review findings', () => {
  it('a start beside the runway end (ramp, run-up area) is parked, not holding short', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 40, cross: -120, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(ksfo);
    h.tick();
    expect(h.atc.phase).toBe('PARKED');
    expect(h.atc.options.some((o) => o.startsWith('Request taxi for VFR departure'))).toBe(true);
  });

  it('ATIS magnetic wind is converted from the observed direction, not from the true wind already rounded to 10°', () => {
    const ksfo = airport('KSFO');
    const decl = magneticDeclinationDeg(ksfo.position.lat, ksfo.position.lon, 0, UTC);
    expect(decl).toBeGreaterThan(11);
    expect(decl).toBeLessThan(15);
    const weather = ksfoWeather({ winds: [{ altM: 14, directionDeg: 285, speedKt: 12, gustKt: 0 }] });
    const r = buildAtis({ airport: ksfo, weather, letter: 'A', utcMs: UTC, runways: ['28R'], magVarDeg: decl });
    expect(r.text).toContain('Wind 270 at 12.'); // 285 − 13 = 272 → 270 (not 290 − 13 → 280)
    expect(r.metar).toContain('29012KT');
  });

  it('readbacks: straight-in subtitle uses digits; a closed-traffic takeoff readback includes the pattern', () => {
    const cs = makeCallsign('N172FS', 'Cessna').short;
    expect(readback.patternEntry(cs, 'straight-in', 'left', '28R')).toEqual({
      text: 'Straight-in runway 28R, report 3 mile final, Cessna 2FS.',
      speech: 'Straight-in runway two eight right, report three mile final, Cessna Two Foxtrot Sierra.',
    });
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 800, cross: -700, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(ksfo);
    h.wait(1);
    h.select(/^Request taxi for closed traffic/);
    h.wait(3);
    h.select(/^Read back: taxi/);
    const rwy = h.atc.runwayIdent ?? '';
    const ref = allRunwayRefs(ksfo).find((r) => r.ident === rwy);
    const r28R = allRunwayRefs(ksfo).find((r) => r.ident === '28R');
    if (!ref || !r28R) throw new Error(`runway ${rwy} missing`);
    const thr = relativeTo(makeRunwayFrame(ksfo, r28R), ref.threshold, 4, 0);
    h.move({ along: thr.alongM + 40, cross: thr.crossM - 90, h: 0 }, 8, true);
    h.wait(3);
    expect(h.atc.phase).toBe('HOLDING_SHORT');
    h.select(new RegExp(`^Ready for departure, runway ${rwy}, remaining in the pattern`));
    h.wait(3);
    expect(h.find(/cleared for takeoff\.$/)?.text).toMatch(/^Cessna 2FS, San Francisco Tower, make left closed traffic, wind .*, runway 28L, cleared for takeoff\.$/);
    h.select(/^Read back: left closed traffic, runway 28L, cleared for takeoff/);
    expect(h.messages[h.messages.length - 1].text).toBe('Left closed traffic, runway 28L, cleared for takeoff, Cessna 2FS.');
  });

  it('with flight following active, an arrival chosen from the menu can cancel it', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), OFFSHORE, UTC);
    h.setMotion(50, 0, false);
    h.atc.reset(null);
    h.wait(2);
    h.select(/^Request VFR flight following \(Departure [\d.]+\)/);
    h.wait(3);
    h.select(/^Read back squawk/);
    expect(h.atc.squawk).not.toBe(1200);
    h.select(/^Prepare to land at Half Moon Bay \(KHAF\)/);
    expect(h.atc.phase).toBe('INBOUND');
    h.select(/^Cancel flight following \(Departure [\d.]+\)/);
    h.wait(3);
    expect(h.find(/radar service terminated/)?.text).toBe('Cessna 2FS, radar service terminated, squawk VFR, frequency change approved.');
    expect(h.atc.squawk).toBe(1200);
    expect(h.atc.phase).toBe('INBOUND');
  });

  it('a readback not given before the next call is no longer offered', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 17000, cross: 12700, h: 900 }, UTC);
    h.setMotion(50, 0, false);
    h.atc.reset(null);
    h.wait(2);
    h.select(/^Prepare to land at San Francisco \(KSFO\)/);
    h.select(/^Inbound for landing, full stop/);
    h.wait(3);
    expect(h.atc.options[0]).toMatch(/^Read back: enter right downwind runway 28R/);
    // No readback: fly to the downwind and report there.
    h.move({ along: 3500, cross: 2300, h: 300 }, 50, false, 0.25);
    h.move({ along: 1500, cross: 1500, h: 300 }, 40, false);
    expect(h.atc.patternLeg).toBe('downwind');
    h.select(/^Report midfield right downwind runway 28R/);
    h.wait(3);
    expect(h.find(/roger, report base/)).toBeDefined();
    expect(h.atc.options.some((o) => o.startsWith('Read back'))).toBe(false);
  });
});

describe('holding short', () => {
  it('stopping at another runway end after a first hold-short stop makes that the departure runway', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 800, cross: -700, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(ksfo);
    h.wait(1);
    h.select(/^Request taxi for VFR departure/);
    h.wait(3);
    h.select(/^Read back: taxi/);
    expect(h.atc.runwayIdent).toBe('28L');
    // First stop: on the extended centreline just before the 19L threshold (28R frame: 1496, 944).
    h.move({ along: 1496, cross: 1064, h: 0 }, 8, true);
    h.wait(3);
    expect(h.atc.phase).toBe('HOLDING_SHORT');
    expect(h.atc.runwayIdent).toBe('19L');
    // Then on to the assigned runway's hold-short point.
    h.move({ along: 39, cross: -318, h: 0 }, 8, true);
    h.wait(3);
    expect(h.atc.runwayIdent).toBe('28L');
    expect(h.atc.options[0]).toBe('Ready for departure, runway 28L (Tower 120.5)');
  });
});

describe('runway selection', () => {
  it('below 5 kt the calm-wind (longest) runway is used (FAA JO 7110.65 §3-5-1, research 05 §9.1)', () => {
    const ksfo = airport('KSFO');
    expect(runwaysInUse(ksfo, 30, 4)?.primary.ident).toBe('10L'); // longest runway, end most into the light wind
    expect(runwaysInUse(ksfo, 30, 6)?.primary.ident).toBe('1R'); // ≥ 5 kt: most nearly aligned with the wind
    expect(runwaysInUse(ksfo, 280, 12)?.all.map((r) => r.ident)).toEqual(['28L', '28R']);
  });
});

describe('automatic inbound detection with flight following', () => {
  it('closing on a towered field at an angle (passing by) neither makes it the destination nor ends radar service', () => {
    const ksfo = airport('KSFO');
    const r28R = allRunwayRefs(ksfo).find((r) => r.ident === '28R');
    if (!r28R) throw new Error('28R missing');
    const arp = relativeTo(makeRunwayFrame(ksfo, r28R), ksfo.position, 4, 0);
    // 20 km (10.8 nm) out over the ocean, inside the 12 nm inbound range.
    const p0: Point = { along: arp.alongM + 20000, cross: arp.crossM, h: 900 };
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), p0, UTC);
    h.setMotion(50, 0, false);
    h.atc.reset(null);
    h.wait(2);
    h.select(/^Request VFR flight following \(Departure [\d.]+\)/);
    h.wait(3);
    h.select(/^Read back squawk/);
    const code = h.atc.squawk;
    expect(code).not.toBe(1200);
    // 60° off the bearing to the field: still closing at ~25 m/s, but not heading for it.
    h.move({ along: p0.along - 1500, cross: p0.cross + 2598, h: 900 }, 50, false, 0.25);
    expect(h.atc.phase).toBe('ENROUTE');
    expect(h.atc.squawk).toBe(code);
    expect(h.messages.some((m) => /radar service terminated/.test(m.text))).toBe(false);
  });
});

describe('arrival at an untowered field on flight following', () => {
  it('radar is asked for the landing and approves the change to the advisory frequency', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), OFFSHORE, UTC);
    h.setMotion(50, 0, false);
    h.atc.reset(null);
    h.wait(2);
    h.select(/^Request VFR flight following \(Departure [\d.]+\)/);
    h.wait(3);
    h.select(/^Read back squawk/);
    h.select(/^Prepare to land at Half Moon Bay \(KHAF\)/);
    const i = h.select(/^Request landing at Half Moon Bay \(Departure [\d.]+\)/);
    expect(h.messages[i].text).toMatch(/^.+ Departure, Cessna 2FS, request landing at Half Moon Bay\.$/);
    h.wait(3);
    expect(h.find(/radar service terminated/)?.text).toBe('Cessna 2FS, radar service terminated, squawk VFR, change to advisory frequency approved.');
    expect(h.atc.squawk).toBe(1200);
    h.select(/^Acknowledge: squawk VFR/);
    expect(h.atc.frequencyMHz).toBe(122.9);
    expect(h.atc.options.some((o) => o.startsWith('Announce inbound, full stop (CTAF 122.9)'))).toBe(true);
  });
});
