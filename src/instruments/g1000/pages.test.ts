import { beforeAll, describe, expect, it } from 'vitest';
import type { NavDb } from '../../nav';
import { loadTestNav, makeRig } from '../testing/g1000Rig';
import { MockCanvasFactory, type MockContext2D } from '../testing/mockCanvas';
import { makeSampleSnapshot } from '../testing/sampleSnapshot';
import { ConfirmWindow, MenuWindow } from './fmsWindows';
import { G1000 } from './G1000';
import { PFD_MENUS, MFD_MENUS } from './fmsSoftkeys';

let nav: NavDb;
beforeAll(async () => { nav = await loadTestNav(); });

type Rig = ReturnType<typeof makeRig>;
const TEN = ['KSFO', 'KOAK', 'KHWD', 'KLVK', 'KCCR', 'KAPC', 'KSTS', 'KDVO', 'KSQL', 'KPAO', 'KSJC'];

/** Scenarios: inputs that bring up a page / dialog, and a text the display must then show. */
const SCENARIOS: { name: string; display: 'pfd' | 'mfd'; go: (r: Rig) => void; expect: string }[] = [
  { name: 'MFD map', display: 'mfd', go: () => undefined, expect: 'MAP - NAVIGATION MAP' },
  { name: 'MFD FPL page with cursor', display: 'mfd', go: (r) => { r.btn('mfd', 'FPL'); r.input({ type: 'push', display: 'mfd', id: 'FMS' }); }, expect: 'ACTIVE FLIGHT PLAN' },
  { name: 'MFD FPL insertion entry', display: 'mfd', go: (r) => { r.btn('mfd', 'FPL'); r.input({ type: 'push', display: 'mfd', id: 'FMS' }); r.knob('mfd', 'FMS', 3); }, expect: 'ACTIVE FLIGHT PLAN' },
  { name: 'MFD NRST airports', display: 'mfd', go: (r) => { r.btn('mfd', 'NRST'); r.input({ type: 'push', display: 'mfd', id: 'FMS' }); r.knob('mfd', 'FMS', 1, 'outer'); }, expect: 'NEAREST AIRPORTS' },
  { name: 'MFD NRST VOR', display: 'mfd', go: (r) => { r.btn('mfd', 'NRST'); r.knob('mfd', 'FMS', 1); }, expect: 'NEAREST VOR' },
  { name: 'MFD NRST NDB', display: 'mfd', go: (r) => { r.btn('mfd', 'NRST'); r.knob('mfd', 'FMS', 2); }, expect: 'NEAREST NDB' },
  { name: 'MFD D→ spelling', display: 'mfd', go: (r) => { r.btn('mfd', 'DIRECT'); r.type('mfd', 'KS'); }, expect: 'DIRECT TO' },
  { name: 'MFD D→ duplicates', display: 'mfd', go: (r) => { r.btn('mfd', 'DIRECT'); r.type('mfd', 'OAK'); r.btn('mfd', 'ENT'); }, expect: 'NEAREST MATCHES' },
  { name: 'MFD PROC', display: 'mfd', go: (r) => { r.btn('mfd', 'PROC'); r.btn('mfd', 'ENT'); }, expect: 'LOAD?' },
  { name: 'MFD page menu', display: 'mfd', go: (r) => { r.btn('mfd', 'FPL'); r.btn('mfd', 'MENU'); }, expect: 'PAGE MENU' },
  { name: 'MFD confirm', display: 'mfd', go: (r) => { r.btn('mfd', 'FPL'); r.input({ type: 'push', display: 'mfd', id: 'FMS' }); r.btn('mfd', 'CLR'); }, expect: 'REMOVE KSFO?' },
  { name: 'MFD map options, track up, declutter', display: 'mfd', go: (r) => { r.input({ type: 'softkey', display: 'mfd', index: 8 }); r.input({ type: 'softkey', display: 'mfd', index: 8 }); r.input({ type: 'softkey', display: 'mfd', index: 2 }); r.input({ type: 'softkey', display: 'mfd', index: 7 }); }, expect: 'TRK UP' },
  { name: 'PFD D→', display: 'pfd', go: (r) => { r.btn('pfd', 'DIRECT'); r.knob('pfd', 'FMS', 3); }, expect: 'DIRECT TO' },
  { name: 'PFD FPL window', display: 'pfd', go: (r) => { r.btn('pfd', 'FPL'); r.input({ type: 'push', display: 'pfd', id: 'FMS' }); }, expect: 'ACTIVE FLIGHT PLAN' },
  { name: 'PFD NRST window', display: 'pfd', go: (r) => r.input({ type: 'softkey', display: 'pfd', index: 9 }), expect: 'NEAREST AIRPORTS' },
  { name: 'PFD PROC window', display: 'pfd', go: (r) => r.btn('pfd', 'PROC'), expect: 'PROCEDURES - SELECT APPROACH' },
  { name: 'PFD TMR/REF + minimums', display: 'pfd', go: (r) => { r.input({ type: 'softkey', display: 'pfd', index: 8 }); r.knob('pfd', 'FMS', 3, 'outer'); r.btn('pfd', 'ENT'); }, expect: 'TIMER / REFERENCES' },
  { name: 'PFD ALERTS', display: 'pfd', go: (r) => r.input({ type: 'softkey', display: 'pfd', index: 11 }), expect: 'NO ACTIVE ALERTS' },
  { name: 'PFD inset map + XPDR menu + IDENT', display: 'pfd', go: (r) => { r.input({ type: 'softkey', display: 'pfd', index: 0 }); r.input({ type: 'softkey', display: 'pfd', index: 10 }); r.input({ type: 'softkey', display: 'pfd', index: 6 }); r.input({ type: 'softkey', display: 'pfd', index: 8 }); }, expect: 'IDNT' },
  { name: 'PFD menu, wind off, OBS', display: 'pfd', go: (r) => { r.input({ type: 'softkey', display: 'pfd', index: 3 }); r.input({ type: 'softkey', display: 'pfd', index: 2 }); r.input({ type: 'softkey', display: 'pfd', index: 2 }); r.input({ type: 'softkey', display: 'pfd', index: 2 }); }, expect: 'STD BARO' },
];

describe('rendering every page and dialog', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name}: draws without throwing, balanced, showing "${sc.expect}"`, () => {
      const r = makeRig(nav, TEN);
      r.planner.activateLeg(4);
      r.frame();
      sc.go(r);
      const ctx = sc.display === 'pfd' ? r.pfdCtx : r.mfdCtx;
      ctx.clear();
      r.g.invalidate();
      expect(() => r.frame(2)).not.toThrow();
      expect(r.pfdCtx.balanced).toBe(true);
      expect(r.mfdCtx.balanced).toBe(true);
      expect(ctx.texts()).toContain(sc.expect);
    });
  }

  it('works without a nav database or flight planner (messages instead of data), and reset closes windows', () => {
    const factory = new MockCanvasFactory();
    const g = new G1000({ createCanvas: (w, h) => factory.create(w, h) });
    const s = makeSampleSnapshot();
    const mfd = (g.mfdCanvas as unknown as { ctx: MockContext2D }).ctx;
    const steps: (() => void)[] = [
      () => g.handleInput({ type: 'button', display: 'mfd', id: 'DIRECT' }),
      () => { g.handleInput({ type: 'char', char: 'K' }); g.handleInput({ type: 'button', display: 'mfd', id: 'ENT' }); },
      () => g.handleInput({ type: 'button', display: 'mfd', id: 'PROC' }),
      () => g.handleInput({ type: 'button', display: 'mfd', id: 'ENT' }),
      () => g.handleInput({ type: 'button', display: 'mfd', id: 'NRST' }),
      () => g.handleInput({ type: 'button', display: 'mfd', id: 'FPL' }),
      () => g.handleInput({ type: 'push', display: 'mfd', id: 'FMS' }),
      () => g.handleInput({ type: 'button', display: 'mfd', id: 'CLR' }),
      () => g.handleInput({ type: 'button', display: 'pfd', id: 'PROC' }),
      () => g.handleInput({ type: 'softkey', display: 'pfd', index: 9 }),
    ];
    for (const step of steps) { step(); expect(() => g.update(s, 0.1)).not.toThrow(); }
    expect(mfd.balanced).toBe(true);
    expect(g.fms.pfdWindow()).not.toBeNull();
    g.reset(s);
    expect(g.fms.pfdWindow()).toBeNull();
    expect(g.fms.mfdPopups.length).toBe(0);
    expect(g.fms.mfd.title).toBe('MAP - NAVIGATION MAP');
  });

  it('menus and confirmations stack over a page on both displays', () => {
    const r = makeRig(nav, TEN);
    r.f.open('pfd', new MenuWindow(r.f, 'PAGE MENU', [{ label: 'A', enabled: true, run: () => undefined }, { label: 'B', enabled: false, run: () => undefined }]));
    r.f.open('mfd', new ConfirmWindow(r.f, 'SURE?', () => undefined));
    r.pfdCtx.clear(); r.mfdCtx.clear();
    expect(() => r.frame(2)).not.toThrow();
    expect(r.pfdCtx.texts()).toContain('PAGE MENU');
    expect(r.mfdCtx.texts()).toContain('SURE?');
  });

  it('a dead avionics bus blanks the MFD screen but keeps the bezel; windows do not draw', () => {
    const r = makeRig(nav, TEN);
    r.btn('mfd', 'FPL');
    r.s.aircraft.electrical = { busVolts: 0, mainPowered: false, avionicsPowered: false, batteryAmps: 0, alternatorAmps: 0, lowVoltage: true } as never;
    r.mfdCtx.clear();
    r.g.invalidate();
    r.frame();
    const t = r.mfdCtx.texts();
    expect(t).not.toContain('ACTIVE FLIGHT PLAN');
    expect(t).toContain('FMS'); // bezel caption
  });

  it('does not redraw an idle display with a window open, and redraws after an input', () => {
    const r = makeRig(nav, TEN);
    r.btn('pfd', 'PROC');
    r.frame(3);
    let draws = 0;
    for (let i = 0; i < 5; i++) { r.g.update(r.s, 0.05); if (r.g.changed.pfd) draws++; }
    expect(draws).toBe(0);
    r.knob('pfd', 'FMS', 1);
    r.g.update(r.s, 0.05);
    expect(r.g.changed.pfd).toBe(true);
  });

  it('a flight-plan edit made outside the G1000 redraws an open PFD FPL window on the next due frame', () => {
    const r = makeRig(nav, TEN);
    r.btn('pfd', 'FPL');
    r.frame(3);
    for (let i = 0; i < 3; i++) r.g.update(r.s, 0.05);
    r.pfdCtx.clear();
    // e.g. the UI's flight planner inserts a waypoint after the active leg (active leg, DTK, DIS unchanged)
    r.planner.insert(5, { id: 'KHAF', position: nav.getAirport('KHAF')!.position, type: 'airport' });
    r.s.plan = r.planner.update(r.s.aircraft.geo, r.s.aircraft.groundSpeedMs);
    r.g.update(r.s, 0.05);
    expect(r.g.changed.pfd).toBe(true);
    expect(r.pfdCtx.texts()).toContain('KHAF');
    // and nothing more while the plan stays put
    let draws = 0;
    for (let i = 0; i < 5; i++) { r.g.update(r.s, 0.05); if (r.g.changed.pfd) draws++; }
    expect(draws).toBe(0);
  });

  it('every softkey menu has 12 labels with ALERTS on key 12 of the PFD; blank or inert keys do nothing', () => {
    for (const m of Object.values(PFD_MENUS)) { expect(m.length).toBe(12); expect(m[11]).toBe('ALERTS'); }
    for (const m of Object.values(MFD_MENUS)) expect(m.length).toBe(12);
    const r = makeRig(nav);
    expect(r.input({ type: 'softkey', display: 'pfd', index: 10 })).toBe(false); // blank
    expect(r.input({ type: 'softkey', display: 'mfd', index: 0 })).toBe(false); // ENGINE (labelled, inert)
    r.input({ type: 'softkey', display: 'pfd', index: 2 });
    expect(r.input({ type: 'softkey', display: 'pfd', index: 0 })).toBe(false); // SYN VIS
    expect(r.g.fms.pfd.softkeys[0]).toBe('SYN VIS');
  });
});
