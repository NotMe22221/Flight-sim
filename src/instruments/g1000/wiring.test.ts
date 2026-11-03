import { beforeAll, describe, expect, it } from 'vitest';
import type { SimAction } from '../../core/types';
import { RadioStack } from '../../app/radios';
import { GfcAutopilot } from '../../autopilot';
import { FlightPlanner, type NavDb } from '../../nav';
import { loadTestNav } from '../testing/g1000Rig';
import { MockCanvasFactory } from '../testing/mockCanvas';
import { makeSampleSnapshot } from '../testing/sampleSnapshot';
import { G1000 } from './G1000';
import type { ProcWindow } from './procWindow';
import { type G1000Host, applyG1000Command, syncCom1 } from './wiring';

let nav: NavDb;
beforeAll(async () => { nav = await loadTestNav(); });

describe('applyG1000Command', () => {
  it('maps every command onto the host and reports missing targets', () => {
    const tuning: [{ activeKHz: number; standbyKHz: number; obsDeg: number }, { activeKHz: number; standbyKHz: number; obsDeg: number }] = [
      { activeKHz: 116_800, standbyKHz: 109_550, obsDeg: 0 }, { activeKHz: 116_200, standbyKHz: 113_700, obsDeg: 0 }];
    const com1 = { activeMHz: 121.8, standbyMHz: 120.5 };
    const log: string[] = [];
    const host: G1000Host = {
      navTuning: tuning, com1,
      setNavSource: (s) => log.push(`src:${s}`), action: (a: SimAction) => log.push(a), setAltimeterStd: () => log.push('std'),
      transponder: (c, m, i) => log.push(`xpdr:${c}:${m}:${i}`),
    };
    applyG1000Command({ kind: 'navStandby', radio: 2, kHz: 110_300 }, host);
    applyG1000Command({ kind: 'navSwap', radio: 2 }, host);
    expect(tuning[1]).toMatchObject({ activeKHz: 110_300, standbyKHz: 116_200 });
    applyG1000Command({ kind: 'navActive', radio: 1, kHz: 111_700 }, host);
    applyG1000Command({ kind: 'navCourse', radio: 1, courseDeg: -10 }, host);
    expect(tuning[0]).toMatchObject({ activeKHz: 111_700, obsDeg: 350 });
    applyG1000Command({ kind: 'comStandby', radio: 1, kHz: 118_300 }, host);
    applyG1000Command({ kind: 'comSwap', radio: 1 }, host);
    expect(com1).toEqual({ activeMHz: 118.3, standbyMHz: 121.8 });
    expect(applyG1000Command({ kind: 'comStandby', radio: 2, kHz: 118_300 }, host)).toBe(false); // COM2 lives on the G1000
    applyG1000Command({ kind: 'cdiSource', source: 'NAV2', navSource: 'nav2' }, host);
    applyG1000Command({ kind: 'action', action: 'apAltInc', count: 3 }, host);
    applyG1000Command({ kind: 'baroStd' }, host);
    applyG1000Command({ kind: 'xpdr', code: 4217, mode: 'ALT', ident: true }, host);
    expect(log).toEqual(['src:nav2', 'apAltInc', 'apAltInc', 'apAltInc', 'std', 'xpdr:4217:ALT:true']);
    expect(applyG1000Command({ kind: 'baroStd' }, {})).toBe(false);
    const box = { activeKHz: 0, standbyKHz: 0 };
    syncCom1(box, com1);
    expect(box).toEqual({ activeKHz: 118_300, standbyKHz: 121_800 });
  });
});

describe('end to end with the real radio stack and autopilot (the integration recipe)', () => {
  it('knob tuning reaches RadioStack, ILS PROC tunes the localizer, the CDI drives the autopilot NAV source', () => {
    const radios = new RadioStack(nav as never);
    const ap = new GfcAutopilot();
    const planner = new FlightPlanner();
    const actions: SimAction[] = [];
    const host: G1000Host = {
      navTuning: radios.tuning, tuneNavActive: (i, k) => radios.tuneNav(i, k), com1: radios.state.com1,
      setNavSource: (src) => ap.setNavSource(src), action: (a) => actions.push(a),
    };
    const factory = new MockCanvasFactory();
    const g = new G1000({ nav, planner, onCommand: (c) => applyG1000Command(c, host), createCanvas: (w, h) => factory.create(w, h) });
    const s = makeSampleSnapshot();
    s.aircraft.geo.lat = 37.66; s.aircraft.geo.lon = -122.35; // ~8 nm west of KOAK
    s.nav1 = radios.state.nav1; s.nav2 = radios.state.nav2; // the snapshot carries the radio stack's state, as in the Simulator
    const frame = () => { radios.update(0.1, s.aircraft.geo, 13); s.plan = planner.update(s.aircraft.geo, s.aircraft.groundSpeedMs); g.update(s, 0.1); };
    frame();
    expect(ap.navSource).toBe('gps'); // first update syncs the CDI source
    const sb = radios.tuning[0].standbyKHz;
    g.handleInput({ type: 'knob', display: 'pfd', id: 'NAV', steps: 2 });
    g.handleInput({ type: 'knob', display: 'pfd', id: 'NAV', steps: 1 }); // same frame
    expect(radios.tuning[0].standbyKHz).toBe(sb + 150);
    frame();
    expect(s.nav1.standbyKHz).toBe(sb + 150);
    g.handleInput({ type: 'wheel', display: 'mfd', id: 'COM', ring: 'outer', deltaY: -100 });
    expect(radios.state.com1.standbyMHz).toBeCloseTo(g.com1.standbyKHz / 1000, 6);
    // PROC → ILS at KOAK, ACTIVATE
    planner.setWaypoints([{ id: 'KOAK', position: nav.getAirport('KOAK')!.position, type: 'airport' }]);
    g.handleInput({ type: 'button', display: 'mfd', id: 'PROC' });
    const w = g.fms.mfdPopups.at(-1) as ProcWindow;
    const app = w.approaches.find((a) => a.runway === '28R') ?? w.approaches[0];
    w.focus = w.approaches.indexOf(app) + 1;
    g.handleInput({ type: 'button', display: 'mfd', id: 'ENT' });
    g.handleInput({ type: 'knob', display: 'mfd', id: 'FMS', steps: 1 }); // ACTIVATE?
    g.handleInput({ type: 'button', display: 'mfd', id: 'ENT' });
    expect(radios.tuning[0].activeKHz).toBe(app.frequencyKHz);
    expect(ap.navSource).toBe('nav1');
    frame();
    expect(s.nav1.isLocalizer).toBe(true);
    expect(s.nav1.ident).toBe(app.ident);
    // the HSI now shows LOC1
    expect(g.fms.pfd.cdi.label).toBe('LOC1');
    // CDI softkey → NAV2 → GPS
    g.handleInput({ type: 'softkey', display: 'pfd', index: 4 });
    expect(ap.navSource).toBe('nav2');
    g.handleInput({ type: 'softkey', display: 'pfd', index: 4 });
    expect(ap.navSource).toBe('gps');
    // AFCS keys and the HDG knob become actions
    g.handleInput({ type: 'button', display: 'pfd', id: 'APR' });
    g.handleInput({ type: 'wheel', display: 'pfd', id: 'HDG', deltaY: -200 });
    expect(actions).toEqual(['apApr', 'headingBugInc', 'headingBugInc']);
  });
});
