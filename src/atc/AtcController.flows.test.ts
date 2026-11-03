import { beforeAll, describe, expect, it } from 'vitest';
import type { Airport } from '../core/types';
import type { NavDb } from '../nav';
import { findRunwayEnd } from '../nav';
import { fieldInfo, runwaysInUse } from './field';
import { Harness, type Frame } from './__tests__/harness';
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

describe('AtcController — untowered field (CTAF self-announce)', () => {
  it('Half Moon Bay: announcements at each phase, no controller replies', () => {
    const khaf = airport('KHAF');
    const inUse = runwaysInUse(khaf, 280, 12);
    expect(inUse?.primary.ident).toBe('30');
    const h = new Harness(db, ksfoWeather(), frameOf(khaf, '30'), { along: 900, cross: 250, h: 0 }, UTC);
    h.atc.reset(khaf);
    h.setEngine(true);
    h.wait(1);
    expect(h.atc.phase).toBe('PARKED');
    expect(h.atc.options).toContain('Announce taxi to runway 30 for departure (CTAF 122.9)');

    h.select(/^Announce taxi to runway 30 for departure/);
    expect(h.messages[h.messages.length - 1].text).toBe('Half Moon Bay traffic, Cessna 2FS, taxiing to runway 30, Half Moon Bay.');
    expect(h.atc.phase).toBe('TAXI_CLEARED');
    expect(h.atc.frequencyMHz).toBe(122.9);
    h.move({ along: 300, cross: 120, h: 0 }, 6, true);
    h.move({ along: -20, cross: 60, h: 0 }, 5, true);
    h.wait(3);
    expect(h.atc.phase).toBe('HOLDING_SHORT');

    h.select(/^Announce departing runway 30/);
    expect(h.messages[h.messages.length - 1].text).toBe('Half Moon Bay traffic, Cessna 2FS, departing runway 30, Half Moon Bay.');
    expect(h.atc.phase).toBe('CLEARED_TAKEOFF');
    h.move({ along: 50, cross: 0, h: 0 }, 5, true);
    h.move({ along: 600, cross: 0, h: 0 }, 25, true);
    h.move({ along: 800, cross: 0, h: 5 }, 30, false);
    h.wait(1.2);
    expect(h.atc.phase).toBe('DEPARTING');
    expect(h.atc.options).toEqual(['Announce departing the area (CTAF 122.9)', 'Announce remaining in the pattern (CTAF 122.9)']);
    h.move({ along: 7500, cross: 0, h: 500 }, 40, false);
    expect(h.atc.phase).toBe('ENROUTE');

    h.select(/^Prepare to land at Half Moon Bay \(KHAF\)/);
    expect(h.atc.phase).toBe('INBOUND');
    h.select(/^Announce inbound, full stop/);
    expect(h.messages[h.messages.length - 1].text).toMatch(/^Half Moon Bay traffic, Cessna 2FS, \d+ miles \w+, 1,[0-9]00, inbound, will enter left downwind runway 30, full stop, Half Moon Bay\.$/);
    expect(h.atc.phase).toBe('PATTERN');
    h.move({ along: 3000, cross: -1200, h: 300 }, 40, false);
    h.move({ along: 700, cross: -1200, h: 300 }, 40, false);
    expect(h.atc.patternLeg).toBe('downwind');
    h.select(/^Announce left downwind runway 30/);
    expect(h.messages[h.messages.length - 1].text).toBe('Half Moon Bay traffic, Cessna 2FS, left downwind runway 30, Half Moon Bay.');
    h.move({ along: -1200, cross: -1200, h: 250 }, 40, false);
    h.move({ along: -1200, cross: -600, h: 200 }, 35, false);
    expect(h.atc.patternLeg).toBe('base');
    h.select(/^Announce left base runway 30/);
    expect(h.messages[h.messages.length - 1].text).toBe('Half Moon Bay traffic, Cessna 2FS, turning left base runway 30, Half Moon Bay.');
    h.move({ along: -1300, cross: 0, h: 150 }, 35, false);
    h.move({ along: -700, cross: 0, h: 80 }, 35, false);
    expect(h.atc.patternLeg).toBe('final');
    h.select(/^Announce final runway 30/);
    h.move({ along: 150, cross: 0, h: 1 }, 30, false);
    h.move({ along: 200, cross: 0, h: 0 }, 28, true);
    h.wait(0.5);
    expect(h.atc.phase).toBe('LANDED');
    h.move({ along: 900, cross: 0, h: 0 }, 10, true);
    h.select(/^Announce clear of runway 30/);
    expect(h.messages[h.messages.length - 1].text).toBe('Half Moon Bay traffic, Cessna 2FS, clear of runway 30, Half Moon Bay.');
    expect(h.atc.phase).toBe('TAXI_IN');
    h.move({ along: 900, cross: 250, h: 0 }, 5, true);
    h.setEngine(false);
    h.wait(4);
    expect(h.atc.phase).toBe('PARKED');

    expect(h.phases).toEqual(['PARKED', 'TAXI_CLEARED', 'HOLDING_SHORT', 'CLEARED_TAKEOFF', 'DEPARTING', 'ENROUTE', 'INBOUND', 'PATTERN', 'LANDED', 'TAXI_IN', 'PARKED']);
    expect(h.messages.filter((m) => m.from === 'atc')).toHaveLength(0);
    expect(h.messages.every((m) => m.frequencyMHz === 122.9)).toBe(true);
    expect(h.emptyOptionFrames).toBe(0);
  });
});

describe('AtcController — starts, closed traffic and touch-and-go', () => {
  it('spawning on the runway starts at HOLDING_SHORT with the takeoff call offered', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 40, cross: 0, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(ksfo);
    h.tick();
    expect(h.atc.phase).toBe('HOLDING_SHORT');
    expect(h.atc.runwayIdent).toBe('28R');
    expect(h.atc.options[0]).toBe('Ready for departure, runway 28R (Tower 120.5)');
  });

  it('an airborne start begins en route with options; bad selections are refused', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 0, cross: 18000, h: 900 }, UTC);
    h.setMotion(50, 0, false);
    h.atc.reset(null);
    h.wait(2);
    expect(h.atc.phase).toBe('ENROUTE');
    expect(h.atc.options.length).toBeGreaterThan(0);
    expect(h.atc.select(11)).toBe(false);
    expect(h.atc.select(-1)).toBe(false);
    expect(h.atc.select(0)).toBe(false); // no 10th option
  });

  it('closed traffic with touch-and-go keeps the aircraft in the pattern and re-clears it', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 40, cross: 0, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(ksfo);
    h.tick();
    h.select(/^Ready for departure/);
    h.wait(3);
    h.select(/^Read back/);
    h.move({ along: 700, cross: 0, h: 0 }, 25, true);
    h.move({ along: 900, cross: 0, h: 5 }, 30, false);
    h.wait(1.2);
    expect(h.atc.phase).toBe('DEPARTING');
    h.select(/^Request closed traffic/);
    h.wait(3);
    expect(h.find(/make right closed traffic/)?.text).toBe('Cessna 2FS, make right closed traffic runway 28R, report downwind.');
    expect(h.atc.phase).toBe('PATTERN');
    h.select(/^Read back/);
    h.move({ along: 3000, cross: 0, h: 250 }, 35, false);
    h.move({ along: 3000, cross: 1500, h: 300 }, 35, false);
    h.move({ along: 1500, cross: 1500, h: 300 }, 40, false);
    h.select(/^Request touch and go/);
    h.wait(3);
    expect(h.find(/roger, touch and go/)?.text).toBe('Cessna 2FS, roger, touch and go.');
    h.move({ along: -1500, cross: 1500, h: 250 }, 40, false);
    h.move({ along: -1600, cross: 0, h: 160 }, 35, false);
    h.move({ along: -1000, cross: 0, h: 100 }, 35, false);
    expect(h.atc.landingClearance).toBe('touch-and-go');
    expect(h.find(/cleared touch and go/)?.text).toBe('Cessna 2FS, wind 270 at 12 gusting 18, runway 28R, cleared touch and go.');
    h.move({ along: 250, cross: 0, h: 1 }, 32, false);
    h.move({ along: 700, cross: 0, h: 0 }, 30, true);
    expect(h.atc.phase).toBe('PATTERN');
    h.move({ along: 1200, cross: 0, h: 20 }, 32, false);
    h.wait(1.5);
    expect(h.atc.phase).toBe('PATTERN');
    expect(h.atc.landingClearance).toBe('none');
    // Second circuit: a new touch-and-go clearance once established on final again.
    h.move({ along: 3000, cross: 0, h: 250 }, 35, false);
    h.move({ along: 3000, cross: 1500, h: 300 }, 35, false);
    h.move({ along: -1500, cross: 1500, h: 250 }, 40, false);
    h.move({ along: -1600, cross: 0, h: 160 }, 35, false);
    h.move({ along: -1000, cross: 0, h: 100 }, 35, false);
    expect(h.messages.filter((m) => /cleared touch and go\.$/.test(m.text) && m.from === 'atc')).toHaveLength(2);
    expect(h.messages.filter((m) => /go around,/.test(m.text))).toHaveLength(0);
  });
});

describe('AtcController — determinism, reset and facility fallbacks', () => {
  function shortFlight(): { texts: string[]; times: number[] } {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 40, cross: 0, h: 0 }, UTC);
    h.setEngine(true);
    h.atc.reset(ksfo);
    h.tick();
    h.select(/^Ready for departure/);
    h.wait(3);
    h.select(/^Read back/);
    h.move({ along: 700, cross: 0, h: 0 }, 25, true);
    h.move({ along: 5000, cross: 0, h: 700 }, 35, false);
    return { texts: h.messages.map((m) => m.text), times: h.messages.map((m) => m.t) };
  }

  it('the same inputs give the same transcript (no wall clock, no Math.random)', () => {
    const a = shortFlight();
    const b = shortFlight();
    expect(a.texts.length).toBeGreaterThan(3);
    expect(b).toEqual(a);
  });

  it('reset starts a new flight and republishes the options', () => {
    const ksfo = airport('KSFO');
    const h = new Harness(db, ksfoWeather(), frameOf(ksfo, '28R'), { along: 800, cross: -700, h: 0 }, UTC);
    h.atc.reset(ksfo);
    h.wait(1);
    h.select(/^Request taxi for VFR departure/);
    h.wait(3);
    expect(h.atc.phase).toBe('TAXI_CLEARED');
    const emitted = h.optionLists.length;
    h.atc.reset(ksfo);
    expect(h.atc.awaitingReply).toBe(false);
    h.wait(0.5);
    expect(h.atc.phase).toBe('PARKED');
    expect(h.atc.frequencyMHz).toBeNull();
    expect(h.optionLists.length).toBeGreaterThan(emitted);
    expect(h.atc.options.some((o) => o.startsWith('Request taxi for VFR departure'))).toBe(true);
  });

  it('a towered field without a ground frequency taxis with the tower; untowered falls back to MULTICOM', () => {
    const base = airport('KHAF');
    const towerOnly: Airport = { ...base, frequencies: [{ type: 'TWR', mhz: 118.6 }] };
    const f = fieldInfo(towerOnly);
    expect(f.towered).toBe(true);
    expect(f.ground).toBe(f.tower);
    expect(f.ground?.name.text).toBe('Half Moon Bay Tower');
    const none = fieldInfo({ ...base, frequencies: [] });
    expect(none.towered).toBe(false);
    expect(none.ctaf.mhz).toBe(122.9);
    expect(none.ctaf.name.text).toBe('Half Moon Bay traffic');
  });
});
