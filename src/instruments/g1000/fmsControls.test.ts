import { beforeAll, describe, expect, it } from 'vitest';
import { FT, NM } from '../../core/units';
import { type NavDb, ilsApproaches } from '../../nav';
import { colouredTexts, loadTestNav, makeRig } from '../testing/g1000Rig';
import { MockCanvasFactory } from '../testing/mockCanvas';
import { DirectToWindow } from './directTo';
import { G1000 } from './G1000';
import type { G1000Command } from './input';
import { NearestWindow } from './nearestWindow';
import { ProcWindow } from './procWindow';

let nav: NavDb;
beforeAll(async () => { nav = await loadTestNav(); });
const rig = (ids: string[] = []) => makeRig(nav, ids);
const kinds = (cmds: G1000Command[]) => cmds.map((c) => c.kind);
const last = <K extends G1000Command['kind']>(cmds: G1000Command[], kind: K) => cmds.filter((c) => c.kind === kind).at(-1) as Extract<G1000Command, { kind: K }> | undefined;

describe('NRST', () => {
  it('MFD NRST page lists nearby airports with bearing, distance, runway and frequency; D→ from the list', () => {
    const r = rig();
    r.btn('mfd', 'NRST');
    const page = r.f.mfdPage() as NearestWindow;
    expect(page).toBeInstanceOf(NearestWindow);
    r.frame(2);
    expect(page.airports.length).toBeGreaterThan(5);
    const first = page.airports[0];
    expect(first.icao).toBe(nav.nearestAirports(r.s.aircraft.geo, 1, 50)[0].icao);
    const col = colouredTexts(r.mfdCtx);
    r.g.invalidate(); r.frame();
    expect(col.has(first.icao)).toBe(true);
    expect([...col.keys()].some((t) => /^\d+FT /.test(t))).toBe(true); // runway length
    expect([...col.keys()].some((t) => /^(TWR|CTAF|UNIC|A\/G|AFIS|GND) \d{3}\.\d{2,3}$/.test(t))).toBe(true);
    // cursor on, pick the 3rd airport, D→ prefilled with it, ENT goes direct
    r.input({ type: 'push', display: 'mfd', id: 'FMS' });
    r.knob('mfd', 'FMS', 2);
    const pick = page.airports[2].icao;
    r.btn('mfd', 'DIRECT');
    const d = r.f.mfdPopups.at(-1) as DirectToWindow;
    expect(d.target?.ident).toBe(pick);
    expect(d.target?.name).not.toBe('');
    r.btn('mfd', 'ENT');
    expect(r.planner.activeWaypoint?.id).toBe(pick);
  });

  it('ENT on an airport opens D→; outer knob → frequency list, ENT loads it into COM1 standby', () => {
    const r = rig();
    r.btn('mfd', 'NRST');
    r.frame();
    r.input({ type: 'push', display: 'mfd', id: 'FMS' });
    const page = r.f.nrstPage;
    const ksfoIdx = page.airports.findIndex((a) => a.icao === 'KSFO');
    r.knob('mfd', 'FMS', ksfoIdx);
    r.knob('mfd', 'FMS', 1, 'outer'); // into KSFO's frequencies
    expect(page.focus).toBe('freq');
    r.btn('mfd', 'ENT');
    const c = last(r.cmds, 'comStandby')!;
    expect(c.radio).toBe(1);
    expect(c.kHz).toBe(120_500); // KSFO tower first
    expect(r.g.com1.standbyKHz).toBe(120_500); // the G1000's own COM1 box shows it too (contract of comStandby)
    r.knob('mfd', 'FMS', 1, 'outer'); // back to the list
    r.btn('mfd', 'ENT');
    expect((r.f.mfdPopups.at(-1) as DirectToWindow).target?.ident).toBe('KSFO');
  });

  it('NRST VOR page: ENT tunes the VOR into NAV1 standby; APT/VOR/NDB softkeys switch pages', () => {
    const r = rig();
    r.btn('mfd', 'NRST');
    r.input({ type: 'softkey', display: 'mfd', index: 6 }); // VOR
    expect(r.f.mfdPageIndex).toBe(1);
    expect(r.g.fms.mfd.title).toBe('NRST - NEAREST VOR');
    r.frame();
    const page = r.f.nrstPage;
    expect(page.navaids.length).toBeGreaterThan(0);
    expect(page.navaids.every((n) => n.type !== 'NDB')).toBe(true);
    r.input({ type: 'push', display: 'mfd', id: 'FMS' });
    r.btn('mfd', 'ENT');
    expect(last(r.cmds, 'navStandby')).toEqual({ kind: 'navStandby', radio: 1, kHz: page.navaids[0].frequencyKHz });
    r.input({ type: 'softkey', display: 'mfd', index: 7 }); // NDB
    r.frame();
    expect(page.type).toBe('ndb');
    expect(page.navaids.every((n) => n.type === 'NDB')).toBe(true);
  });

  it('PFD NRST softkey opens the nearest-airports window; CLR closes it', () => {
    const r = rig();
    r.input({ type: 'softkey', display: 'pfd', index: 9 });
    const w = r.f.pfdWindow() as NearestWindow;
    expect(w).toBeInstanceOf(NearestWindow);
    expect(w.cursor).toBe(true);
    r.frame();
    expect(w.airports.length).toBeGreaterThan(0);
    expect(r.g.fms.pfd.softkeyMask & (1 << 9)).toBeTruthy();
    r.btn('pfd', 'ENT'); // D→ to the nearest airport, on the PFD
    expect((r.f.pfdWindow() as DirectToWindow).target?.ident).toBe(w.airports[0].icao);
    r.btn('pfd', 'CLR'); r.btn('pfd', 'CLR');
    expect(r.f.pfdWindow()).toBeNull();
  });
});

describe('PROC (ILS)', () => {
  it('selects an ILS at the destination, ACTIVATE: fixes into the plan, LOC into NAV1 with its course, CDI → NAV1', () => {
    const r = rig(['KSFO', 'KOAK']);
    r.btn('mfd', 'PROC');
    const w = r.f.mfdPopups.at(-1) as ProcWindow;
    expect(w).toBeInstanceOf(ProcWindow);
    expect(w.airport?.icao).toBe('KOAK'); // the destination
    const apps = ilsApproaches(nav.getAirport('KOAK')!);
    expect(w.approaches.map((a) => a.name)).toEqual(apps.map((a) => a.name));
    expect(w.focus).toBe(1);
    r.btn('mfd', 'ENT'); // choose the first approach
    expect(w.chosen).toBe(0);
    r.knob('mfd', 'FMS', 1); // LOAD? → ACTIVATE?
    expect(w.focus).toBe(w.activateIndex);
    r.cmds.length = 0;
    r.btn('mfd', 'ENT');
    const a = apps[0];
    expect(r.f.mfdPopups.length).toBe(0);
    expect(last(r.cmds, 'navActive')).toEqual({ kind: 'navActive', radio: 1, kHz: a.frequencyKHz });
    const crs = last(r.cmds, 'navCourse')!;
    expect(crs.radio).toBe(1);
    expect(Math.abs(((crs.courseDeg - (a.courseTrueDeg - 13)) % 360 + 540) % 360 - 180)).toBeLessThan(1);
    expect(last(r.cmds, 'cdiSource')).toEqual({ kind: 'cdiSource', source: 'NAV1', navSource: 'nav1' });
    expect(r.g.cdiSource).toBe('NAV1');
    expect(r.planner.waypoints.map((x) => x.id)).toEqual(['KSFO', `FF${a.runway}`, `RW${a.runway}`, 'KOAK']);
    expect(r.planner.activeWaypoint?.id).toBe(`FF${a.runway}`);
    expect(r.planner.isDirectTo).toBe(true);
    const ff = r.planner.waypoints[r.planner.indexOfId(`FF${a.runway}`)];
    expect(ff.altConstraintM! - a.threshold.alt).toBeCloseTo(Math.tan(a.glideslopeDeg * Math.PI / 180) * 5 * NM, 0);
    expect(ff.altConstraintM! / FT).toBeGreaterThan(1500);
  });

  it('LOAD keeps the CDI on GPS and arms the switch to LOC once the localizer is alive on the final', () => {
    const r = rig(['KSFO', 'KOAK']);
    r.btn('pfd', 'PROC');
    const w = r.f.pfdWindow() as ProcWindow;
    r.btn('pfd', 'ENT'); r.btn('pfd', 'ENT'); // choose, LOAD
    expect(r.g.cdiSource).toBe('GPS');
    const app = w.approaches[0];
    expect(r.planner.indexOfId(`RW${app.runway}`)).toBe(2); // KSFO, FFxx, RWxx, KOAK
    // fly the final: the leg FAF → runway is active and the localizer comes alive
    r.planner.activateLeg(2);
    r.s.nav1.activeKHz = app.frequencyKHz; r.s.nav1.isLocalizer = true; r.s.nav1.valid = true; r.s.nav1.cdi = 0.2;
    r.frame();
    expect(r.g.cdiSource).toBe('NAV1');
    // loading another approach replaces the fixes instead of piling them up
    r.btn('pfd', 'PROC'); r.btn('pfd', 'ENT'); r.btn('pfd', 'ENT');
    expect(r.planner.waypoints.filter((x) => x.id.startsWith('RW')).length).toBe(1);
  });

  it('the airport can be re-spelled (falls back to the nearest without a plan); no ILS → message', () => {
    const r = rig();
    r.btn('mfd', 'PROC');
    const w = r.f.mfdPopups.at(-1) as ProcWindow;
    expect(w.airport?.icao).toBe(nav.nearestAirports(r.s.aircraft.geo, 1, 100)[0].icao);
    w.focus = 0;
    r.type('mfd', 'KSFO'); r.btn('mfd', 'ENT');
    expect(w.airport?.icao).toBe('KSFO');
    expect(w.approaches.some((a) => a.runway === '28R')).toBe(true);
    w.focus = 0;
    r.type('mfd', 'KHAF'); r.btn('mfd', 'ENT'); // small field, no ILS
    expect(w.message).toBe('NO ILS APPROACHES');
    r.btn('mfd', 'PROC'); // toggles closed
    expect(r.f.mfdPopups.length).toBe(0);
  });
});

describe('PFD softkeys', () => {
  it('CDI cycles GPS → NAV1 → NAV2 → GPS and asks the autopilot to follow', () => {
    const r = rig();
    expect(last(r.cmds, 'cdiSource')).toEqual({ kind: 'cdiSource', source: 'GPS', navSource: 'gps' }); // initial sync
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) { r.input({ type: 'softkey', display: 'pfd', index: 4 }); seen.push(last(r.cmds, 'cdiSource')!.navSource); }
    expect(seen).toEqual(['nav1', 'nav2', 'gps']);
  });

  it('reset (new flight / panel swap) re-announces the CDI source once on the next update', () => {
    const r = rig();
    r.input({ type: 'softkey', display: 'pfd', index: 4 }); // NAV1
    r.frame();
    const n = r.cmds.length;
    r.g.reset(r.s);
    expect(r.cmds.length).toBe(n); // nothing until the next update
    r.frame(3);
    expect(r.cmds.slice(n)).toEqual([{ kind: 'cdiSource', source: 'NAV1', navSource: 'nav1' }]);
  });

  it('OBS suspends sequencing with a selectable GPS course (CRS knob); a second press resumes', () => {
    const r = rig(['KSFO', 'KOAK', 'KHWD']);
    r.frame();
    r.input({ type: 'softkey', display: 'pfd', index: 3 });
    const obs = r.planner.obsCourseDeg!;
    expect(obs).not.toBeNull();
    r.knob('pfd', 'CRS_BARO', 10);
    expect(r.planner.obsCourseDeg!).toBeCloseTo((obs + 10) % 360, 6);
    r.frame();
    expect(r.s.plan!.desiredTrackDeg).toBeCloseTo((obs + 10) % 360, 6);
    r.input({ type: 'softkey', display: 'pfd', index: 3 });
    expect(r.planner.obsCourseDeg).toBeNull();
  });

  it('INSET shows the inset map (RANGE knob on the PFD zooms it), OFF removes it; DCLTR cycles', () => {
    const r = rig();
    const p = r.g.fms.pfd;
    r.input({ type: 'softkey', display: 'pfd', index: 0 });
    expect(p.insetOn).toBe(true);
    expect(r.g.fms.pfdMenu).toBe('inset');
    expect(p.softkeys[0]).toBe('OFF');
    const before = p.insetRangeNm;
    r.knob('pfd', 'RANGE', 2);
    expect(p.insetRangeNm).toBeGreaterThan(before);
    r.input({ type: 'softkey', display: 'pfd', index: 1 });
    expect(p.softkeys[1]).toBe('DCLTR-1');
    r.frame();
    r.input({ type: 'softkey', display: 'pfd', index: 0 });
    expect(p.insetOn).toBe(false);
    expect(r.g.fms.pfdMenu).toBe('root');
  });

  it('PFD menu: WIND cycles option 1 / 2 / off, BRG1 / BRG2 sources, DME, STD BARO, BACK', () => {
    const r = rig();
    const p = r.g.fms.pfd;
    r.input({ type: 'softkey', display: 'pfd', index: 2 });
    expect(r.g.fms.pfdMenu).toBe('pfd');
    r.input({ type: 'softkey', display: 'pfd', index: 2 });
    expect(p.windOption).toBe(2);
    r.input({ type: 'softkey', display: 'pfd', index: 2 });
    expect(p.windOn).toBe(false);
    r.input({ type: 'softkey', display: 'pfd', index: 4 });
    expect(p.brg1.source).toBe('GPS');
    r.input({ type: 'softkey', display: 'pfd', index: 4 });
    expect(p.brg1.source).toBe('OFF');
    r.input({ type: 'softkey', display: 'pfd', index: 6 });
    expect(p.brg2.source).toBe('OFF');
    r.input({ type: 'softkey', display: 'pfd', index: 3 });
    expect(p.dmeSource).toBe('NAV2');
    r.input({ type: 'softkey', display: 'pfd', index: 9 });
    expect(last(r.cmds, 'baroStd')).toEqual({ kind: 'baroStd' });
    r.input({ type: 'softkey', display: 'pfd', index: 1 }); // DFLTS
    expect([p.windOn, p.windOption, p.brg1.source, p.brg2.source]).toEqual([true, 1, 'NAV1', 'GPS']);
    r.input({ type: 'softkey', display: 'pfd', index: 10 });
    expect(r.g.fms.pfdMenu).toBe('root');
    expect(r.input({ type: 'softkey', display: 'pfd', index: 1 })).toBe(false); // blank key
  });

  it('XPDR: modes, VFR, CODE entry with digits and BKSP, IDENT for 18 s', () => {
    const r = rig();
    const p = r.g.fms.pfd;
    r.input({ type: 'softkey', display: 'pfd', index: 6 });
    r.input({ type: 'softkey', display: 'pfd', index: 2 }); // STBY
    expect(p.xpdrMode).toBe('STBY');
    r.input({ type: 'softkey', display: 'pfd', index: 4 }); // ALT
    r.input({ type: 'softkey', display: 'pfd', index: 7 }); // CODE
    for (const k of [4, 5, 9, 2, 1, 7]) r.input({ type: 'softkey', display: 'pfd', index: k === 9 ? 9 : k }); // 4 5 BKSP 2 1 7
    expect(p.squawk).toBe(4217);
    expect(last(r.cmds, 'xpdr')).toEqual({ kind: 'xpdr', code: 4217, mode: 'ALT', ident: false });
    r.input({ type: 'softkey', display: 'pfd', index: 6 }); // VFR
    expect(p.squawk).toBe(1200);
    r.input({ type: 'softkey', display: 'pfd', index: 10 }); // BACK
    r.input({ type: 'softkey', display: 'pfd', index: 7 }); // IDENT
    expect(p.identS).toBe(18);
    expect(last(r.cmds, 'xpdr')!.ident).toBe(true);
    r.frame(181);
    expect(p.identS).toBe(0);
    expect(last(r.cmds, 'xpdr')!.ident).toBe(false);
  });

  it('TMR/REF: timer START / STOP / RESET, V-speed bugs, minimums; ALERTS window', () => {
    const r = rig();
    r.input({ type: 'softkey', display: 'pfd', index: 8 });
    expect(r.f.pfdWindow()!.kind).toBe('tmrref');
    r.btn('pfd', 'ENT'); // START
    expect(r.g.model.timerIsRunning).toBe(true);
    r.frame(30);
    expect(r.g.model.readings.clock.timerS).toBeGreaterThan(2);
    r.btn('pfd', 'ENT'); // STOP
    expect(r.g.model.timerIsRunning).toBe(false);
    r.knob('pfd', 'FMS', 1); r.btn('pfd', 'ENT'); // RESET
    r.frame();
    expect(r.g.model.readings.clock.timerS).toBeLessThan(0.5);
    r.knob('pfd', 'FMS', 1, 'outer'); r.btn('pfd', 'ENT');
    expect(r.g.fms.pfd.vspeedBugs).toBe(false);
    r.knob('pfd', 'FMS', 1, 'outer'); r.knob('pfd', 'FMS', 5);
    expect(r.g.fms.pfd.minimumsFt).toBe(250);
    r.knob('pfd', 'FMS', 1, 'outer'); r.btn('pfd', 'ENT');
    expect(r.g.fms.pfd.minimumsOn).toBe(true);
    r.input({ type: 'softkey', display: 'pfd', index: 11 });
    expect(r.f.pfdWindow()!.kind).toBe('alerts');
    r.input({ type: 'softkey', display: 'pfd', index: 11 });
    expect(r.f.pfdWindow()!.kind).toBe('tmrref');
  });
});

describe('knobs, keys and radio requests', () => {
  it('NAV: inner 50 kHz / outer 1 MHz on the focused standby, push toggles NAV1/NAV2, transfer key swaps', () => {
    const r = rig();
    const sb = r.s.nav1.standbyKHz;
    r.knob('pfd', 'NAV', 1);
    expect(last(r.cmds, 'navStandby')).toEqual({ kind: 'navStandby', radio: 1, kHz: sb + 50 });
    r.knob('pfd', 'NAV', 2); // two more steps within the same frame accumulate
    expect(last(r.cmds, 'navStandby')!.kHz).toBe(sb + 150);
    r.knob('pfd', 'NAV', -1, 'outer');
    expect(last(r.cmds, 'navStandby')!.kHz).toBe(sb + 150 - 1000);
    r.input({ type: 'push', display: 'pfd', id: 'NAV' });
    expect(r.g.fms.pfd.navFocus).toBe(2);
    r.knob('pfd', 'NAV', 1);
    expect(last(r.cmds, 'navStandby')!.radio).toBe(2);
    r.btn('pfd', 'NAV_SWAP');
    expect(last(r.cmds, 'navSwap')).toEqual({ kind: 'navSwap', radio: 2 });
  });

  it('COM: 25 kHz / 1 MHz steps on the G1000 COM standby (and a request), transfer swaps', () => {
    const r = rig();
    const c1 = r.g.com1, sb = c1.standbyKHz, act = c1.activeKHz;
    r.knob('mfd', 'COM', 1);
    expect(c1.standbyKHz).toBe(sb + 25);
    expect(last(r.cmds, 'comStandby')).toEqual({ kind: 'comStandby', radio: 1, kHz: sb + 25 });
    r.knob('mfd', 'COM', 1, 'outer');
    expect(c1.standbyKHz).toBe(sb + 1025);
    r.btn('mfd', 'COM_SWAP');
    expect([c1.activeKHz, c1.standbyKHz]).toEqual([sb + 1025, act]);
    expect(last(r.cmds, 'comSwap')).toEqual({ kind: 'comSwap', radio: 1 });
    r.input({ type: 'push', display: 'mfd', id: 'COM' });
    r.knob('mfd', 'COM', -1);
    expect(last(r.cmds, 'comStandby')!.radio).toBe(2);
  });

  it('HDG / ALT / BARO / CRS knobs and the AFCS keys become simulator actions', () => {
    const r = rig();
    r.cmds.length = 0;
    r.knob('pfd', 'HDG', 3);
    r.input({ type: 'push', display: 'pfd', id: 'HDG' });
    r.knob('pfd', 'ALT', 2); r.knob('pfd', 'ALT', -1, 'outer');
    r.knob('pfd', 'CRS_BARO', -2, 'outer');
    const acts = r.cmds.filter((c) => c.kind === 'action').map((c) => c.kind === 'action' ? `${c.action}x${c.count}` : '');
    expect(acts).toEqual(['headingBugIncx3', 'apHdgSyncx1', 'apAltIncx2', 'apAltDecx10', 'altimeterDecx2']);
    // CRS with the CDI on NAV1 sets the OBS; push centres it on the bearing to the station
    r.g.setCdiSource('NAV1');
    const obs = r.s.nav1.obsDeg;
    r.knob('pfd', 'CRS_BARO', 5);
    expect(last(r.cmds, 'navCourse')).toEqual({ kind: 'navCourse', radio: 1, courseDeg: (obs + 5) % 360 });
    r.input({ type: 'push', display: 'pfd', id: 'CRS_BARO' });
    expect(last(r.cmds, 'navCourse')!.courseDeg).toBe(Math.round(r.s.nav1.bearingDeg) % 360);
    r.cmds.length = 0;
    for (const id of ['AP', 'FD', 'HDG', 'ALT', 'NAV', 'APR', 'VS', 'FLC', 'NOSE_UP'] as const) r.btn('pfd', id);
    expect(r.cmds.map((c) => (c.kind === 'action' ? c.action : c.kind))).toEqual(['apToggle', 'fdToggle', 'apHdg', 'apAlt', 'apNav', 'apApr', 'apVs', 'apFlc', 'apVsInc']);
    r.s.autopilot.vertical = 'FLC'; r.frame();
    r.btn('pfd', 'NOSE_UP');
    expect(last(r.cmds, 'action')!.action).toBe('apIasDec');
    expect(r.btn('pfd', 'VNV')).toBe(true); // labelled, inert
    expect(kinds(r.cmds).every((k) => k === 'action')).toBe(true);
  });

  it('MFD FMS knob without a cursor: outer = page group, inner = page; RANGE knob = map range', () => {
    const r = rig();
    r.knob('mfd', 'FMS', 1, 'outer');
    expect(r.g.fms.mfd.title).toBe('FPL - ACTIVE FLIGHT PLAN');
    r.knob('mfd', 'FMS', 1, 'outer');
    r.knob('mfd', 'FMS', 1);
    expect(r.g.fms.mfd.title).toBe('NRST - NEAREST VOR');
    r.knob('mfd', 'FMS', 1, 'outer');
    expect(r.g.fms.mfd.title).toBe('MAP - NAVIGATION MAP');
    const range = r.g.rangeNm;
    r.knob('mfd', 'RANGE', -1);
    expect(r.g.rangeNm).toBeLessThan(range);
    r.input({ type: 'softkey', display: 'mfd', index: 8 }); // DCLTR
    expect(r.g.fms.mfd.declutter).toBe(1);
    expect(r.g.fms.mfd.softkeys[8]).toBe('DCLTR-1');
    r.input({ type: 'softkey', display: 'mfd', index: 2 }); // MAP → options
    r.input({ type: 'softkey', display: 'mfd', index: 7 }); // orientation
    expect(r.g.mapOrientation).toBe('track-up');
    expect(r.g.fms.mfd.softkeys[7]).toBe('TRK UP');
  });

  it('without onCommand, requests queue for takeCommands(); keyboard() routes typed idents', () => {
    const r = makeRig(nav);
    const factory = new MockCanvasFactory();
    const g2 = new G1000({ nav, planner: r.planner, createCanvas: (w, h) => factory.create(w, h) });
    g2.handleInput({ type: 'knob', display: 'pfd', id: 'HDG', steps: 1 });
    expect(g2.takeCommands()).toEqual([{ kind: 'action', action: 'headingBugInc', count: 1 }]);
    expect(g2.takeCommands()).toEqual([]);
    expect(r.g.keyboard('k')).toBe(false); // nothing is waiting for typing yet
    r.btn('mfd', 'DIRECT');
    expect(r.g.wantsKeyboard).toBe(true);
    for (const k of ['k', 's', 'f', 'o']) expect(r.g.keyboard(k)).toBe(true);
    expect(r.g.keyboard('Backspace')).toBe(true);
    expect(r.g.keyboard('o')).toBe(true);
    expect(r.g.keyboard('F5')).toBe(false);
    r.g.keyboard('Enter'); r.g.keyboard('Enter');
    expect(r.planner.activeWaypoint?.id).toBe('KSFO');
    r.btn('mfd', 'DIRECT'); r.g.keyboard('Escape'); // CLR closes an empty D→ window
    expect(r.f.mfdPopups.length).toBe(0);
  });
});
