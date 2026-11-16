import { beforeAll, describe, expect, it } from 'vitest';
import type { Airport } from '../core/types';
import type { NavDb } from '../nav';
import { findRunwayEnd } from '../nav';
import { Harness, type Frame, type Point } from './__tests__/harness';
import { ksfoWeather, loadBayAreaDb } from './__tests__/fixtures';

const UTC = Date.UTC(2026, 10, 3, 18, 56);
const RAMP: Point = { along: 800, cross: -700, h: 0 };
let db: NavDb, ksfo: Airport, frame28R: Frame;

beforeAll(async () => {
  db = await loadBayAreaDb();
  ksfo = db.getAirport('KSFO')!;
  const end = findRunwayEnd(ksfo, '28R')!;
  frame28R = { threshold: end.end.threshold, headingDeg: end.end.headingDeg, elevationM: 4 };
});

function taxiClearance(route: ((icao: string, rwy: string) => string[] | null) | null) {
  const h = new Harness(db, ksfoWeather(), frame28R, RAMP, UTC);
  const asked: string[] = [];
  (h.atc as unknown as { s: { taxiRoute: unknown } }).s.taxiRoute = route ? (icao: string, rwy: string) => { asked.push(`${icao}:${rwy}`); return route(icao, rwy); } : null;
  h.atc.reset(ksfo);
  h.wait(1);
  h.setEngine(true);
  h.select(/^Request taxi for VFR departure/);
  h.wait(6);
  return { h, asked };
}

describe('ATC taxi clearance with a taxi route', () => {
  it('names the taxiways (spelled phonetically in speech) in the clearance and the readback', () => {
    const { h, asked } = taxiClearance(() => ['L2', 'A', 'A6']);
    const rwy = h.atc.runwayIdent!;
    expect(asked).toEqual([`KSFO:${rwy}`]);
    const clr = h.messages.find((m) => m.from === 'atc' && /taxi to runway/.test(m.text))!;
    expect(clr.text.startsWith(`Cessna 2FS, San Francisco Ground, taxi to runway ${rwy} via L2, A, A6, hold short of runway ${rwy}.`)).toBe(true);
    expect(h.speech.some((sp) => sp.voice === 'atc' && sp.text.includes('via Lima two, Alpha, Alpha six'))).toBe(true);
    expect(h.select(/^Read back: taxi to runway .* via L2, A, A6, hold short/)).toBeGreaterThanOrEqual(0);
    expect(h.messages[h.messages.length - 1].text).toBe(`Taxi to runway ${rwy} via L2, A, A6, hold short of runway ${rwy}, Cessna 2FS.`);
  });

  it('without a route (no OSM taxiways, or the hook fails) the clearance is the plain one', () => {
    for (const route of [null, () => null, () => { throw new Error('boom'); }]) {
      const { h } = taxiClearance(route as never);
      const rwy = h.atc.runwayIdent!;
      expect(h.messages.find((m) => m.from === 'atc' && /taxi to runway/.test(m.text))!.text.startsWith(`Cessna 2FS, San Francisco Ground, taxi to runway ${rwy}, hold short of runway ${rwy}.`)).toBe(true);
    }
  });
});

describe('ATC: a parked start beside a runway end', () => {
  it('stays PARKED (Ground offers taxi) until the aircraft has actually taxied', () => {
    // 150 m before the 28R threshold and 150 m to its side: inside the hold-short area, but a stand
    const h = new Harness(db, ksfoWeather(), frame28R, { along: -150, cross: -150, h: 0 }, UTC);
    h.atc.reset(ksfo);
    h.wait(1);
    h.setEngine(true);
    h.wait(10);
    expect(h.atc.phase).toBe('PARKED');
    expect(h.atc.options.some((o) => /^Request taxi/.test(o))).toBe(true);
    // taxi 80 m and stop there: now a stop in the area is holding short
    h.move({ along: -150, cross: -70, h: 0 }, 5, true);
    h.wait(5);
    expect(h.atc.phase).toBe('HOLDING_SHORT');
  });
});

describe('ATC: cleared runway follows the taxi network', () => {
  it('clears to the in-use parallel the taxiways reach when the nearest one is unreachable', () => {
    const nearest = taxiClearance(null).h.atc.runwayIdent!;
    const other = nearest === '28L' ? '28R' : '28L';
    const { h, asked } = taxiClearance((_icao, rwy) => (rwy === other ? ['L2', 'A', 'A6'] : null));
    expect(asked[0]).toBe(`KSFO:${nearest}`); // the nearest is tried first
    expect(h.atc.runwayIdent).toBe(other);
    const clr = h.messages.find((m) => m.from === 'atc' && /taxi to runway/.test(m.text))!;
    expect(clr.text.startsWith(`Cessna 2FS, San Francisco Ground, taxi to runway ${other} via L2, A, A6, hold short of runway ${other}.`)).toBe(true);
  });
});
