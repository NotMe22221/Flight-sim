import { beforeAll, describe, expect, it } from 'vitest';
import type { Airport } from '../core/types';
import type { NavDb } from '../nav';
import { findRunwayEnd } from '../nav';
import { makeRunwayFrame, relativeTo } from './geometry';
import { allRunwayRefs } from './field';
import { Harness, type Frame, type Point } from './__tests__/harness';
import { ksfoWeather, loadBayAreaDb } from './__tests__/fixtures';
import type { AtcPhase } from './types';

const UTC = Date.UTC(2026, 10, 3, 18, 56);
const RAMP: Point = { along: 800, cross: -700, h: 0 };

let db: NavDb;
let ksfo: Airport;
let frame28R: Frame;

beforeAll(async () => {
  db = await loadBayAreaDb();
  const ap = db.getAirport('KSFO');
  if (!ap) throw new Error('KSFO missing');
  ksfo = ap;
  const end = findRunwayEnd(ksfo, '28R');
  if (!end) throw new Error('28R missing');
  frame28R = { threshold: end.end.threshold, headingDeg: end.end.headingDeg, elevationM: 4 };
});

/** Threshold of a KSFO runway end in the 28R frame (along, cross). */
function thresholdIn28R(ident: string): { along: number; cross: number } {
  const refs = allRunwayRefs(ksfo);
  const r28 = refs.find((r) => r.ident === '28R');
  const r = refs.find((x) => x.ident === ident);
  if (!r28 || !r) throw new Error(`runway ${ident} missing`);
  const rel = relativeTo(makeRunwayFrame(ksfo, r28), r.threshold, 4, 0);
  return { along: rel.alongM, cross: rel.crossM };
}

/** Print the transcript and option lists (debug aid). */
function dumpTranscript(h: Harness): void {
  for (const m of h.messages) console.log(`${m.t.toFixed(1).padStart(7)} ${m.from.padEnd(5)} ${m.frequencyMHz} ${m.text}`);
  for (const o of h.optionLists) console.log(`${o.t.toFixed(1).padStart(7)} OPTIONS ${o.options.join(' | ')}`);
}

/** Select an option that expects a controller reply; returns the measured reply delay (s). */
function selectWithReply(h: Harness, match: RegExp, replyMatch?: RegExp): number {
  const idx = h.select(match);
  expect(idx).toBeGreaterThanOrEqual(0);
  const pilotMsg = h.messages[idx];
  expect(h.atc.awaitingReply).toBe(true);
  expect(h.atc.select(1)).toBe(false); // ignored while the controller is about to answer
  for (let i = 0; i < 40 && h.after(idx, 'atc').length === 0; i++) h.tick(0.1);
  const reply = h.after(idx, 'atc')[0];
  expect(reply, `reply to "${pilotMsg.text}"`).toBeDefined();
  if (replyMatch) expect(reply.text).toMatch(replyMatch);
  expect(h.messages.indexOf(reply)).toBeGreaterThan(idx); // pilot first, controller after
  expect(reply.frequencyMHz).toBe(pilotMsg.frequencyMHz);
  return reply.t - pilotMsg.t;
}

/** Select a readback (no controller reply expected). */
function readBack(h: Harness, match: RegExp = /^(Read back|Acknowledge)/): void {
  const idx = h.select(match);
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(h.atc.awaitingReply).toBe(false);
}

describe('AtcController — towered round trip at KSFO', () => {
  it('flies parked → taxi → hold short → takeoff → departure → return → pattern → go-around → landing → parked', () => {
    const h = new Harness(db, ksfoWeather(), frame28R, RAMP, UTC);
    h.atc.reset(ksfo);
    const delays: number[] = [];
    h.wait(1);
    expect(h.atc.phase).toBe('PARKED');
    expect(h.atc.options.length).toBeGreaterThan(0);

    // ── ATIS ──
    h.select(/^Listen to ATIS/);
    const atisMsg = h.find(/information/);
    expect(atisMsg?.text).toMatch(/^San Francisco International information [A-Z][a-z]+\. 1856Z\. Wind 270 at 12 gusting 18\./);
    expect(atisMsg?.frequencyMHz).toBe(113.7);
    expect(h.atc.frequencyMHz).toBe(113.7);
    const letterWord = /information ([A-Z][a-z-]+)\./.exec(atisMsg?.text ?? '')?.[1] ?? '';
    h.wait(1);

    // ── Ground: taxi ──
    h.setEngine(true);
    delays.push(selectWithReply(h, /^Request taxi for VFR departure \(Ground 121\.8\)/, /^Cessna 2FS, San Francisco Ground, taxi to runway 28[LR], hold short of runway 28[LR]\.$/));
    const taxiReq = h.messages.find((m) => m.from === 'pilot' && /request taxi/.test(m.text));
    expect(taxiReq?.text).toBe(`San Francisco Ground, N172FS, at the ramp, with information ${letterWord}, request taxi, VFR departure.`);
    expect(h.speech.some((sp) => sp.voice === 'pilot' && sp.text.includes('November One Seven Two Foxtrot Sierra'))).toBe(true);
    expect(h.speech.some((sp) => sp.voice === 'atc' && sp.text.startsWith('Cessna Two Foxtrot Sierra, San Francisco Ground'))).toBe(true);
    expect(h.atc.phase).toBe('TAXI_CLEARED');
    expect(h.atc.frequencyMHz).toBe(121.8);
    const rwy = h.atc.runwayIdent ?? '';
    expect(['28L', '28R']).toContain(rwy);
    readBack(h, /^Read back: taxi to runway/);
    expect(h.messages[h.messages.length - 1].text).toBe(`Taxi to runway ${rwy}, hold short of runway ${rwy}, Cessna 2FS.`);

    // Taxi to the hold-short point beside the runway end and stop.
    const thr = thresholdIn28R(rwy);
    h.move({ along: 300, cross: thr.cross - 400, h: 0 }, 8, true);
    h.move({ along: thr.along + 40, cross: thr.cross - 90, h: 0 }, 5, true);
    expect(h.atc.phase).toBe('TAXI_CLEARED');
    h.wait(3);
    expect(h.atc.phase).toBe('HOLDING_SHORT');

    // ── Tower: takeoff ──
    delays.push(selectWithReply(h, new RegExp(`^Ready for departure, runway ${rwy} \\(Tower 120\\.5\\)`),
      new RegExp(`^Cessna 2FS, San Francisco Tower, wind 270 at 12 gusting 18, runway ${rwy}, cleared for takeoff\\.$`)));
    expect(h.atc.phase).toBe('CLEARED_TAKEOFF');
    readBack(h, /^Read back: runway/);
    h.move({ along: thr.along + 100, cross: thr.cross, h: 0 }, 5, true);
    h.move({ along: thr.along + 700, cross: thr.cross, h: 0 }, 25, true);
    h.move({ along: thr.along + 900, cross: thr.cross, h: 3 }, 30, false);
    h.wait(1.2);
    expect(h.atc.phase).toBe('DEPARTING');

    // ── Climb out → handoff to departure at 2,000 ft ──
    h.move({ along: thr.along + 5000, cross: thr.cross, h: 700 }, 35, false);
    expect(h.atc.phase).toBe('ENROUTE');
    const handoff = h.find(/contact San Francisco Departure/);
    expect(handoff?.text).toBe('Cessna 2FS, contact San Francisco Departure 120.9.');
    expect(handoff?.from).toBe('atc');
    expect(h.messages.filter((m) => /contact San Francisco Departure/.test(m.text))).toHaveLength(1);
    readBack(h, /^Read back: contact San Francisco Departure/);
    expect(h.atc.frequencyMHz).toBe(120.9);

    // ── Flight following ──
    delays.push(selectWithReply(h, /^Request VFR flight following \(Departure 120\.9\)/, /^Cessna 2FS, San Francisco Departure, squawk [2-6][0-7]{3}, radar contact .*, altimeter 30\.05, maintain VFR\.$/));
    expect(h.atc.squawk).not.toBe(1200);
    readBack(h, /^Read back squawk/);

    // ── Out west, north, then back toward the field ──
    h.move({ along: 20000, cross: thr.cross, h: 1000 }, 50, false, 0.25);
    h.move({ along: 20000, cross: 15000, h: 1000 }, 50, false, 0.25);
    expect(h.atc.phase).toBe('ENROUTE');
    h.move({ along: 17000, cross: 12700, h: 900 }, 50, false, 0.25);
    expect(h.atc.phase).toBe('INBOUND');
    expect(h.atc.airportIcao).toBe('KSFO');
    expect(h.find(/radar service terminated/)?.text).toBe('Cessna 2FS, radar service terminated, squawk VFR, contact San Francisco Tower 120.5.');
    readBack(h, /^Acknowledge: squawk VFR/);
    expect(h.atc.frequencyMHz).toBe(120.5);
    expect(h.atc.squawk).toBe(1200);

    // ── Tower: inbound, pattern entry by geometry ──
    delays.push(selectWithReply(h, /^Inbound for landing, full stop \(Tower 120\.5\)/, /^Cessna 2FS, San Francisco Tower, enter right downwind runway 28R, report midfield downwind\./));
    expect(h.atc.phase).toBe('PATTERN');
    expect(h.atc.runwayIdent).toBe('28R');
    readBack(h, /^Read back: enter right downwind/);

    // 45° entry, then the right downwind.
    h.move({ along: 3500, cross: 2300, h: 300 }, 50, false, 0.25);
    h.move({ along: 2500, cross: 1500, h: 300 }, 40, false);
    h.move({ along: 1500, cross: 1500, h: 300 }, 40, false);
    expect(h.atc.patternLeg).toBe('downwind');
    delays.push(selectWithReply(h, /^Report midfield right downwind runway 28R/, /^Cessna 2FS, roger, report base\.$/));
    h.move({ along: -1500, cross: 1500, h: 250 }, 40, false);
    h.move({ along: -1500, cross: 800, h: 200 }, 35, false);
    expect(h.atc.patternLeg).toBe('base');
    delays.push(selectWithReply(h, /^Report right base runway 28R/, /^Cessna 2FS, roger, report final\.$/));
    h.move({ along: -1600, cross: 0, h: 160 }, 35, false);
    // Turn final: landing clearance is issued once established (unsolicited, once).
    h.move({ along: -1200, cross: 0, h: 120 }, 35, false);
    expect(h.atc.patternLeg).toBe('final');
    expect(h.atc.landingClearance).toBe('land');
    expect(h.find(/cleared to land/)?.text).toBe('Cessna 2FS, wind 270 at 12 gusting 18, runway 28R, cleared to land.');
    readBack(h, /^Read back: runway 28R, cleared to land/);

    // ── Go-around on short final ──
    h.move({ along: -600, cross: 0, h: 60 }, 35, false);
    h.move({ along: 400, cross: 0, h: 120 }, 35, false);
    const ga = h.find(/go around/);
    expect(ga?.text).toBe('Cessna 2FS, go around, fly runway heading, climb and maintain 1,000, make right traffic runway 28R.');
    expect(h.atc.landingClearance).toBe('none');
    expect(h.atc.phase).toBe('PATTERN');
    readBack(h, /^Read back go-around/);

    // ── Second circuit and landing ──
    h.move({ along: 3000, cross: 0, h: 250 }, 35, false);
    h.move({ along: 3000, cross: 1500, h: 300 }, 35, false);
    expect(h.atc.patternLeg).toBe('crosswind');
    h.move({ along: -1500, cross: 1500, h: 250 }, 40, false);
    h.move({ along: -1600, cross: 0, h: 160 }, 35, false);
    h.move({ along: -1000, cross: 0, h: 100 }, 35, false);
    expect(h.atc.landingClearance).toBe('land');
    readBack(h, /^Read back: runway 28R, cleared to land/);
    h.move({ along: 250, cross: 0, h: 1 }, 32, false);
    h.move({ along: 300, cross: 0, h: 0 }, 30, true);
    h.wait(0.5);
    expect(h.atc.phase).toBe('LANDED');
    h.move({ along: 1200, cross: 0, h: 0 }, 25, true);
    h.move({ along: 1500, cross: 0, h: 0 }, 8, true);
    expect(h.find(/exit runway/)?.text).toBe('Cessna 2FS, exit runway when able, contact Ground 121.8.');
    readBack(h, /^Read back: exit runway/);
    expect(h.atc.frequencyMHz).toBe(121.8);
    h.move({ along: 1600, cross: -100, h: 0 }, 5, true);

    // ── Ground: taxi to parking ──
    delays.push(selectWithReply(h, /^Report clear of runway, request taxi to parking \(Ground 121\.8\)/, /^Cessna 2FS, San Francisco Ground, taxi to parking\.$/));
    expect(h.atc.phase).toBe('TAXI_IN');
    readBack(h, /^Read back: taxi to parking/);
    h.move(RAMP, 6, true);
    h.setEngine(false);
    h.wait(4);
    expect(h.atc.phase).toBe('PARKED');

    if (process.env.ATC_DUMP) dumpTranscript(h); // ATC_DUMP=1 npx vitest run src/atc/AtcController.test.ts
    // ── Whole-flight assertions ──
    const expected: AtcPhase[] = ['PARKED', 'TAXI_CLEARED', 'HOLDING_SHORT', 'CLEARED_TAKEOFF', 'DEPARTING', 'ENROUTE', 'INBOUND', 'PATTERN', 'LANDED', 'TAXI_IN', 'PARKED'];
    expect(h.phases).toEqual(expected);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(1.5);
      expect(d).toBeLessThanOrEqual(3);
    }
    expect(h.emptyOptionFrames).toBe(0);
    expect(h.optionLists.every((l) => l.options.length > 0 && l.options.length <= 10)).toBe(true);
    // Options are published on change only — never every frame, never the same list twice in a row.
    expect(h.optionLists.length).toBeLessThan(h.updates / 20);
    for (let i = 1; i < h.optionLists.length; i++) expect(h.optionLists[i].options).not.toEqual(h.optionLists[i - 1].options);
    // Unsolicited calls happen once each (two approaches → two landing clearances).
    expect(h.messages.filter((m) => m.from === 'atc' && /cleared to land/.test(m.text))).toHaveLength(2);
    expect(h.messages.filter((m) => /go around,/.test(m.text))).toHaveLength(1);
    expect(h.messages.filter((m) => /exit runway when able/.test(m.text))).toHaveLength(1);
    // Every transmission carries its frequency; speech mirrors subtitles one-to-one.
    expect(h.messages.every((m) => typeof m.frequencyMHz === 'number')).toBe(true);
    expect(h.speech).toHaveLength(h.messages.length);
    expect(h.speech.every((sp) => !/\d/.test(sp.text))).toBe(true);
  });
});
