/**
 * Review follow-ups for the interactive G1000: each test failed before its fix.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { NavDb } from '../../nav';
import { loadTestNav, makeRig } from '../testing/g1000Rig';
import { mockCanvas } from '../testing/mockCanvas';
import { destinationPoint } from '../../geo/wgs84';
import { drawNavStatus } from './afcsBox';
import { BEZEL, bezelRegions, controlKey, drawBezel } from './bezel';
import { DirectToWindow } from './directTo';
import { IdentField, type WindowDrawData } from './fmsCore';
import { FplWindow } from './fplWindow';
import { createCdiState, resolveCdi } from './navData';
import { PFD_WINDOW } from './pfd';
import { ProcWindow } from './procWindow';

let nav: NavDb;
beforeAll(async () => { nav = await loadTestNav(); });
const rig = (ids: string[] = []) => makeRig(nav, ids);
const TEN = ['KSFO', 'KOAK', 'KHWD', 'KLVK', 'KCCR', 'KAPC', 'KSTS', 'KDVO', 'KSQL', 'KPAO', 'KSJC'];

/** Idents a window draws, rendered on its own into a fresh mock context. */
function drawnTexts(r: ReturnType<typeof rig>, w: FplWindow, compact: boolean): string[] {
  const { ctx, ctx2d } = mockCanvas(1024, 768);
  const data: WindowDrawData = { ctx: r.f, r: r.g.model.readings, compact };
  w.draw(ctx2d, PFD_WINDOW, data);
  return ctx.texts();
}

describe('FPL window', () => {
  it('without the cursor the PFD FPL window scrolls to the active leg (FROM and TO rows visible)', () => {
    const r = rig(TEN);
    r.planner.activateLeg(9); // KSQL → KPAO, far below the window's first rows
    r.btn('pfd', 'FPL');
    r.frame();
    const w = r.f.pfdWindow() as FplWindow;
    expect(w.cursor).toBe(false);
    const texts = drawnTexts(r, w, true);
    expect(texts).toContain('KPAO');
    expect(texts).toContain('KSQL');
    // the cursor takes over the scrolling again
    r.input({ type: 'push', display: 'pfd', id: 'FMS' });
    w.sel = 0;
    expect(drawnTexts(r, w, true)).toContain('KSFO');
  });

  it('D→ with the cursor on the second of two same-ident waypoints (round trip) goes to that one', () => {
    const r = rig(['KHAF', 'KSFO', 'KOAK', 'KHAF']);
    expect(r.planner.activeLeg).toBeLessThan(3);
    r.btn('mfd', 'FPL');
    r.input({ type: 'push', display: 'mfd', id: 'FMS' });
    r.knob('mfd', 'FMS', 3, 'outer'); // the destination KHAF
    r.btn('mfd', 'DIRECT');
    expect((r.f.mfdPopups.at(-1) as DirectToWindow).target?.ident).toBe('KHAF');
    r.btn('mfd', 'ENT');
    expect(r.planner.activeLeg).toBe(3);
    // and the departure KHAF when that is the one selected
    r.knob('mfd', 'FMS', -3, 'outer');
    r.btn('mfd', 'DIRECT'); r.btn('mfd', 'ENT');
    expect(r.planner.activeLeg).toBe(0);
  });

  it('reset() also clears the PFD FPL window cursor and entry', () => {
    const r = rig(TEN);
    r.btn('pfd', 'FPL');
    r.input({ type: 'push', display: 'pfd', id: 'FMS' });
    r.type('pfd', 'KO');
    const w = r.f.pfdWindow() as FplWindow;
    expect(w.cursor).toBe(true);
    expect(w.entry).not.toBeNull();
    r.g.reset(r.s);
    r.btn('pfd', 'FPL');
    expect(r.f.pfdWindow()).toBe(w);
    expect(w.cursor).toBe(false);
    expect(w.entry).toBeNull();
  });
});

describe('keyboard routing', () => {
  it('a PFD FPL window without the cursor does not swallow Enter / Escape (menu key, numpad rudder)', () => {
    const r = rig(TEN);
    r.btn('pfd', 'FPL');
    expect(r.f.pfdWindow()).toBeInstanceOf(FplWindow);
    expect(r.g.wantsKeyboard).toBe(false);
    expect(r.g.keyboard('Escape')).toBe(false);
    expect(r.g.keyboard('Enter')).toBe(false);
    expect(r.f.pfdWindow()).toBeInstanceOf(FplWindow);
    // with the cursor on, ENT / CLR belong to the window
    r.input({ type: 'push', display: 'pfd', id: 'FMS' });
    expect(r.g.wantsKeyboard).toBe(true);
    expect(r.g.keyboard('Escape')).toBe(true);
  });

  it('typed letters go to the same window as Enter (a PFD D→ over an MFD FPL page with its cursor on)', () => {
    const r = rig(['KSFO', 'KLVK']);
    r.btn('mfd', 'FPL');
    r.input({ type: 'push', display: 'mfd', id: 'FMS' }); // MFD page cursor on
    r.btn('pfd', 'DIRECT');
    const d = r.f.pfdWindow() as DirectToWindow;
    expect(d).toBeInstanceOf(DirectToWindow);
    for (const c of 'KOAK') expect(r.g.keyboard(c)).toBe(true);
    expect(d.field.text).toBe('KOAK');
    expect(r.f.fplPage.entry).toBeNull();
    r.g.keyboard('Enter'); r.g.keyboard('Enter');
    expect(r.planner.activeWaypoint?.id).toBe('KOAK');
    expect(r.planner.waypoints.map((w) => w.id)).toEqual(['KSFO', 'KLVK']);
  });
});

describe('redraw economy', () => {
  it('a wheel event too small to turn a detent changes nothing and forces no redraw', () => {
    const r = rig();
    const v = r.f.version, n = r.cmds.length;
    r.input({ type: 'wheel', display: 'pfd', id: 'HDG', deltaY: -10 }); // 0.1 detent
    expect(r.f.version).toBe(v);
    expect(r.cmds.length).toBe(n);
    // a whole notch still turns the knob
    r.input({ type: 'wheel', display: 'pfd', id: 'HDG', deltaY: -100 });
    expect(r.cmds.length).toBe(n + 1);
    expect(r.f.version).not.toBe(v);
  });
});

describe('direct-to and GPS course display', () => {
  it('the nav status box shows "D→ WPT" for an in-plan direct-to, not the plan leg into it', () => {
    const r = rig(TEN);
    r.planner.activateLeg(4);
    r.frame();
    const statusTexts = () => { const { ctx, ctx2d } = mockCanvas(1024, 768); drawNavStatus(ctx2d, r.s.plan, 13); return ctx.texts(); };
    expect(statusTexts()).toEqual(expect.arrayContaining(['KLVK', '→', 'KCCR']));
    r.planner.directTo(4, r.s.aircraft.geo); // D→ KCCR from the present position
    r.frame();
    const t = statusTexts();
    expect(t).toEqual(expect.arrayContaining(['D→', 'KCCR']));
    expect(t).not.toContain('KLVK');
  });

  it('GPS CDI flags FROM once the active waypoint is behind (OBS course flown past it, last waypoint passed)', () => {
    const r = rig(['KSFO', 'KOAK']);
    const koak = r.planner.waypoints[1].position;
    r.planner.setObs(45);
    const at = (brg: number, m: number) => { const p = destinationPoint(koak, brg, m); r.s.aircraft.geo.lat = p.lat; r.s.aircraft.geo.lon = p.lon; r.frame(); return resolveCdi(r.s, 'GPS', 13, createCdiState()); };
    expect(at(225, 5000).toFrom).toBe('to');
    expect(at(45, 5000).toFrom).toBe('from');
    r.planner.setObs(null);
    const last = initial(r);
    expect(at(last + 180, 5000).toFrom).toBe('to');
    expect(at(last, 5000).toFrom).toBe('from');
  });
});

/** Initial course of the plan's last leg, deg true. */
function initial(r: ReturnType<typeof rig>): number {
  const w = r.planner.waypoints, a = w[w.length - 2].position, b = w[w.length - 1].position;
  const y = Math.sin((b.lon - a.lon) * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180);
  const x = Math.cos(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180) - Math.sin(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.cos((b.lon - a.lon) * Math.PI / 180);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

describe('ident editing', () => {
  it('Backspace in a prefilled (not yet edited) ident erases its last character, not its first', () => {
    const f = new IdentField(6);
    f.reset('KOAK');
    expect(f.type('\b')).toBe(true);
    expect(f.text).toBe('KOA');
    expect(f.pos).toBe(3);
    f.type('\b');
    expect(f.text).toBe('KO');
    // in the D→ window prefilled from the FPL cursor, Backspace + a letter re-spells the end
    const r = rig(['KSFO', 'KOAK']);
    r.btn('mfd', 'FPL');
    r.input({ type: 'push', display: 'mfd', id: 'FMS' });
    r.knob('mfd', 'FMS', 1, 'outer');
    r.btn('mfd', 'DIRECT');
    const d = r.f.mfdPopups.at(-1) as DirectToWindow;
    expect(d.field.text).toBe('KOAK');
    r.g.keyboard('Backspace');
    expect(d.field.text).toBe('KOA');
    expect(d.target?.ident).toBe('KOAK'); // completion
  });
});

describe('PROC LOAD routing', () => {
  it('LOAD puts the approach before a destination airport that ends the plan: the GPS leg leads to the FAF, not over the field', () => {
    const r = rig(['KSFO', 'KOAK']);
    expect(r.planner.activeWaypoint?.id).toBe('KOAK');
    r.btn('mfd', 'PROC');
    const w = r.f.mfdPopups.at(-1) as ProcWindow;
    const a = w.approaches[0];
    r.btn('mfd', 'ENT'); r.btn('mfd', 'ENT'); // choose, LOAD
    expect(r.planner.waypoints.map((x) => x.id)).toEqual(['KSFO', `FF${a.runway}`, `RW${a.runway}`, 'KOAK']);
    expect(r.planner.activeWaypoint?.id).toBe(`FF${a.runway}`); // the leg into the destination now leads to the FAF
    expect(r.planner.isDirectTo).toBe(false);
    expect(r.g.cdiSource).toBe('GPS');
    // a plan that goes on after the airport keeps its order: the fixes are appended
    const r2 = rig(['KSFO', 'KOAK', 'KHWD']);
    r2.btn('mfd', 'PROC');
    const w2 = r2.f.mfdPopups.at(-1) as ProcWindow;
    expect(w2.airport?.icao).toBe('KHWD');
    w2.focus = 0; r2.type('mfd', 'KOAK'); r2.btn('mfd', 'ENT');
    r2.btn('mfd', 'ENT'); r2.btn('mfd', 'ENT');
    expect(r2.planner.waypoints.map((x) => x.id)).toEqual(['KSFO', 'KOAK', 'KHWD', `FF${a.runway}`, `RW${a.runway}`]);
  });
});

describe('bezel drawing vs hit regions', () => {
  it('every knob is drawn on its hit circle (and inner ring) and every key cap fills its hit rectangle', () => {
    // the region tests only hit-test the regions against themselves; this ties them to the pixels drawn
    const { ctx, ctx2d } = mockCanvas(BEZEL.width, BEZEL.height);
    drawBezel(ctx2d, 'mfd', null);
    const arcs = ctx.calls.filter((c) => c.name === 'arc').map((c) => c.args as number[]);
    const rects = ctx.calls.filter((c) => c.name === 'fillRect').map((c) => c.args as number[]);
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    for (const g of bezelRegions(BEZEL.width, BEZEL.height)) {
      const key = controlKey(g.control);
      if (g.shape === 'circle') {
        expect(arcs.some(([x, y, r]) => near(x, g.cx) && near(y, g.cy) && near(r, g.r)), key).toBe(true);
        if (g.rInner > 0) expect(arcs.some(([x, y, r]) => near(x, g.cx) && near(y, g.cy) && near(r, g.rInner)), key).toBe(true);
      } else if (g.control.kind === 'button') {
        expect(rects.some(([x, y, w, h]) => near(x, g.x) && near(y, g.y) && near(w, g.w) && near(h, g.h)), key).toBe(true);
      } else {
        // softkey: the physical key cap lies inside the region, below the screen
        expect(rects.some(([x, y, w, h]) => x >= g.x && x + w <= g.x + g.w && y >= BEZEL.screenY + BEZEL.screenH && y + h <= g.y + g.h && w > g.w / 2), key).toBe(true);
      }
    }
  });
});
