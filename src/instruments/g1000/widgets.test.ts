import { describe, expect, it } from 'vitest';
import type { SimSnapshot } from '../../core/types';
import { FT, KT } from '../../core/units';
import { C172S_VSPEEDS } from '../c172';
import { InstrumentModel, type InstrumentReadings } from '../readings';
import { mockCanvas } from '../testing/mockCanvas';
import { makeSampleSnapshot } from '../testing/sampleSnapshot';
import { AfcsAnnunciator, MODE_FLASH_S, drawAfcsBox, drawNavStatus, lateralModeLabel, verticalReference } from './afcsBox';
import { ALERT_DEFS, activeAlertCount, alertLevel, alertSoftkey, drawAlerts } from './alerts';
import { drawAirspeedTape } from './airspeedTape';
import { drawAltitudeTape } from './altitudeTape';
import { drawAttitude } from './attitude';
import { drawHsi } from './hsi';
import { drawBearingInfo, drawClock, drawDmeWindow, drawGroundSpeed, drawOat, drawTransponderBox, drawWind } from './infoBoxes';
import { createBearingState, createCdiState, resolveBearing, resolveCdi } from './navData';
import { drawComBox, drawNavBox } from './radioBoxes';
import { drawVsi } from './vsi';

type Case = [string, (s: SimSnapshot) => void];

const CASES: Case[] = [
  ['sample', () => undefined],
  ['AP off and FD off', (s) => { s.autopilot.engaged = false; s.autopilot.flightDirector = false; s.autopilot.lateral = 'OFF'; s.autopilot.vertical = 'OFF'; s.autopilot.armedLateral = null; }],
  ['NAV invalid', (s) => { s.nav1.valid = false; s.nav1.ident = ''; s.nav1.toFrom = 'off'; s.nav1.dmeNm = 0; }],
  ['plan null', (s) => { s.plan = null; }],
  ['negative VS', (s) => { s.aircraft.verticalSpeedMs = -1500 * FT / 60; }],
  ['heading wrap', (s) => { s.aircraft.headingMagRad = 359.6 * Math.PI / 180; s.autopilot.headingBugDeg = 1; s.nav1.obsDeg = 2; }],
  ['ILS localizer + glideslope', (s) => { s.nav1.isLocalizer = true; s.nav1.gsValid = true; s.nav1.gsDeviation = -0.4; s.autopilot.lateral = 'APR'; s.autopilot.vertical = 'GS'; }],
  ['on the ground, engine off', (s) => { s.aircraft.onGround = true; s.aircraft.engine.running = false; s.aircraft.engine.rpm = 0; s.aircraft.aero.ias = 0; s.aircraft.aero.tas = 0; s.aircraft.groundSpeedMs = 0; }],
  ['extreme attitude', (s) => { s.aircraft.euler[0] = 2.5; s.aircraft.euler[1] = -0.9; s.aircraft.rates[2] = 0.3; }],
  ['FLC and VS targets', (s) => { s.autopilot.vertical = 'FLC'; s.autopilot.iasTargetMs = 85 * KT; s.autopilot.armedVertical = 'ALTS'; }],
  ['NaN-ish garbage', (s) => { s.nav1.dmeNm = Number.NaN; s.plan!.eteS = Number.POSITIVE_INFINITY; s.plan!.activeLeg = 9; }],
];

function readingsFor(s: SimSnapshot): InstrumentReadings {
  const m = new InstrumentModel();
  m.update(s, 1 / 60);
  return m.update(s, 1 / 60);
}

function drawAllWidgets(s: SimSnapshot, r: InstrumentReadings, ann: AfcsAnnunciator): ReturnType<typeof mockCanvas> {
  const mc = mockCanvas(1024, 768);
  const ctx = mc.ctx2d, mv = r.heading.magVarDeg;
  const cdi = resolveCdi(s, 'NAV1', mv, createCdiState());
  const gps = resolveCdi(s, 'GPS', mv, createCdiState());
  const b1 = resolveBearing(s, 'NAV1', mv, createBearingState());
  const b2 = resolveBearing(s, 'GPS', mv, createBearingState());
  drawAttitude(ctx, r, s.autopilot);
  drawAirspeedTape(ctx, r, s.autopilot, C172S_VSPEEDS);
  drawAltitudeTape(ctx, r, s.autopilot, s.nav1);
  drawVsi(ctx, r, s.autopilot);
  drawHsi(ctx, r, cdi, b1, b2);
  drawHsi(ctx, r, gps, b1, b2);
  drawAfcsBox(ctx, s.autopilot, ann, cdi);
  drawNavStatus(ctx, s.plan, mv);
  drawNavBox(ctx, s.nav1, s.nav2, 'NAV1');
  drawComBox(ctx, { activeKHz: 120500, standbyKHz: 121800 }, { activeKHz: 118700, standbyKHz: 119300 });
  drawGroundSpeed(ctx, r);
  drawWind(ctx, r, 1);
  drawWind(ctx, r, 2);
  drawOat(ctx, r);
  drawTransponderBox(ctx, 1200, 'ALT');
  drawClock(ctx, r);
  drawDmeWindow(ctx, 'NAV1', s.nav1);
  drawBearingInfo(ctx, 1, b1);
  drawBearingInfo(ctx, 2, b2);
  drawAlerts(ctx, r);
  return mc;
}

describe('PFD widgets on a mock canvas', () => {
  for (const [name, mutate] of CASES) {
    it(`draw without throwing: ${name}`, () => {
      const s = makeSampleSnapshot();
      mutate(s);
      const r = readingsFor(s);
      const ann = new AfcsAnnunciator();
      ann.step(s.autopilot, 1 / 60);
      let mc: ReturnType<typeof mockCanvas> | undefined;
      expect(() => { mc = drawAllWidgets(s, r, ann); }).not.toThrow();
      expect(mc!.ctx.balanced).toBe(true);
      expect(mc!.ctx.calls.length).toBeGreaterThan(200);
    });
  }
});

describe('AFCS status box', () => {
  it('shows nothing but the frame (and no AP) when AP and FD are off', () => {
    const s = makeSampleSnapshot();
    Object.assign(s.autopilot, { engaged: false, flightDirector: false });
    const { ctx, ctx2d } = mockCanvas(1024, 768);
    const ann = new AfcsAnnunciator(); ann.step(s.autopilot, 0.1);
    drawAfcsBox(ctx2d, s.autopilot, ann, createCdiState());
    expect(ctx.count('fillText')).toBe(0);
  });

  it('labels NAV by its CDI source and shows the vertical reference', () => {
    const s = makeSampleSnapshot();
    const cdi = resolveCdi(s, 'GPS', 13, createCdiState());
    expect(lateralModeLabel('NAV', cdi)).toBe('GPS');
    expect(lateralModeLabel('NAV', resolveCdi(s, 'NAV1', 13, createCdiState()))).toBe('VOR');
    s.nav1.isLocalizer = true;
    expect(lateralModeLabel('APR', resolveCdi(s, 'NAV1', 13, createCdiState()))).toBe('LOC');
    expect(lateralModeLabel('OFF', cdi)).toBe('');
    expect(verticalReference(s.autopilot)).toBe('3500FT');
    s.autopilot.vertical = 'VS'; s.autopilot.verticalSpeedTargetMs = -700 * FT / 60;
    expect(verticalReference(s.autopilot)).toBe('-700FPM');
    const { ctx, ctx2d } = mockCanvas(1024, 768);
    const ann = new AfcsAnnunciator(); ann.step(s.autopilot, 0.1);
    drawAfcsBox(ctx2d, s.autopilot, ann, cdi);
    expect(ctx.texts()).toContain('AP');
    expect(ctx.texts()).toContain('HDG');
    expect(ctx.texts().join('')).toContain('-700FPM');
  });

  it('flashes a new mode for 10 s and a red AP after a disconnect', () => {
    const s = makeSampleSnapshot();
    const ann = new AfcsAnnunciator();
    ann.step(s.autopilot, 0.1);
    expect(ann.lateralFlashS).toBe(0); // no flash for the initial state
    s.autopilot.lateral = 'NAV';
    ann.step(s.autopilot, 0.1);
    expect(ann.lateralFlashS).toBe(MODE_FLASH_S);
    for (let i = 0; i < 120; i++) ann.step(s.autopilot, 0.1);
    expect(ann.lateralFlashS).toBe(0);
    s.autopilot.engaged = false;
    ann.step(s.autopilot, 0.1);
    expect(ann.disconnectFlashS).toBeGreaterThan(4.9);
    let sawAp = false;
    for (let i = 0; i < 12; i++) {
      ann.step(s.autopilot, 0.1);
      const { ctx, ctx2d } = mockCanvas(1024, 768);
      drawAfcsBox(ctx2d, s.autopilot, ann, createCdiState());
      if (ctx.texts().includes('AP')) sawAp = true;
    }
    expect(sawAp).toBe(true);
  });
});

describe('alerts and info boxes', () => {
  it('orders warnings before cautions and drives the softkey', () => {
    const r = readingsFor(makeSampleSnapshot());
    for (const d of ALERT_DEFS) r.annunciators[d.key] = false;
    expect(alertLevel(r)).toBeNull();
    expect(alertSoftkey(r).label).toBe('ALERTS');
    r.annunciators.lowVolts = true;
    expect(alertLevel(r)).toBe('caution');
    r.annunciators.oilPress = true;
    expect(alertLevel(r)).toBe('warning');
    expect(alertSoftkey(r).label).toBe('WARNING');
    for (const d of ALERT_DEFS) r.annunciators[d.key] = true;
    expect(activeAlertCount(r)).toBe(ALERT_DEFS.length);
    const { ctx, ctx2d } = mockCanvas(1024, 768);
    drawAlerts(ctx2d, r);
    expect(ctx.texts()[0]).toBe('OIL PRESSURE');
    expect(ctx.texts().some((t) => t.includes('MORE'))).toBe(true);
  });

  it('wind box reads NO WIND DATA on the ground and shows components in option 2', () => {
    const s = makeSampleSnapshot({ onGround: true });
    const r = readingsFor(s);
    const { ctx, ctx2d } = mockCanvas(1024, 768);
    drawWind(ctx2d, r, 1);
    expect(ctx.texts()).toContain('NO WIND');
    const r2 = readingsFor(makeSampleSnapshot());
    ctx.clear();
    drawWind(ctx2d, r2, 2);
    expect(ctx.count('fillText')).toBeGreaterThan(1);
  });

  it('NAV box greens the active frequency of the CDI source and hides an invalid ident', () => {
    const s = makeSampleSnapshot();
    const { ctx, ctx2d } = mockCanvas(1024, 768);
    drawNavBox(ctx2d, s.nav1, s.nav2, 'NAV1');
    const joined = ctx.texts().join('');
    expect(joined).toContain('115.80');
    expect(ctx.texts()).toContain('SFO');
    expect(joined).not.toContain('SFO116');
  });
});

describe('optional nav-radio fields', () => {
  it('uses dmeValid when present, annunciates BC and draws marker beacons', async () => {
    const { dmeDistanceNm } = await import('./navData');
    const { drawMarkerBeacon } = await import('./infoBoxes');
    const s = makeSampleSnapshot();
    expect(dmeDistanceNm(s.nav1)).toBeCloseTo(12.4);
    s.nav1.dmeValid = false;
    expect(Number.isNaN(dmeDistanceNm(s.nav1))).toBe(true);
    s.nav1.isLocalizer = true; s.nav1.backCourse = true;
    const cdi = resolveCdi(s, 'NAV1', 13, createCdiState());
    expect(cdi.backCourse).toBe(true);
    expect(lateralModeLabel('APR', cdi)).toBe('BC');
    const { ctx, ctx2d } = mockCanvas(1024, 768);
    drawMarkerBeacon(ctx2d, null);
    expect(ctx.calls.length).toBe(0);
    drawMarkerBeacon(ctx2d, 'outer');
    drawMarkerBeacon(ctx2d, 'middle');
    drawMarkerBeacon(ctx2d, 'inner');
    expect(ctx.texts()).toEqual(['O', 'M', 'I']);
  });
});
