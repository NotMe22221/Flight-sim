import { beforeAll, describe, expect, it } from 'vitest';
import type { NavDb } from '../../nav';
import { loadTestNav, makeRig } from '../testing/g1000Rig';
import { MockCanvasFactory, type MockContext2D } from '../testing/mockCanvas';
import { BEZEL, type HitRegion, bezelRegions, controlKey, hitTest } from './bezel';
import { G1000 } from './G1000';
import { WheelAccumulator } from './input';
import { G1000Panel } from './panel';

let nav: NavDb;
beforeAll(async () => { nav = await loadTestNav(); });

const centre = (g: HitRegion): [number, number] => (g.shape === 'rect' ? [g.x + g.w / 2, g.y + g.h / 2] : [g.cx, g.cy]);
const find = (regions: readonly HitRegion[], key: string): HitRegion => {
  const r = regions.find((g) => controlKey(g.control) === key);
  if (!r) throw new Error(`no region ${key}`);
  return r;
};

describe('bezel hit regions', () => {
  const regions = bezelRegions(BEZEL.width, BEZEL.height);

  it('has every NXi control exactly once: 12 softkeys, the FMS/AFCS/transfer keys and 9 knobs', () => {
    const keys = regions.map((g) => controlKey(g.control));
    expect(new Set(keys).size).toBe(keys.length);
    for (let i = 0; i < 12; i++) expect(keys).toContain(`softkey:${i}`);
    for (const b of ['DIRECT', 'MENU', 'FPL', 'PROC', 'CLR', 'ENT', 'NAV_SWAP', 'COM_SWAP', 'AP', 'FD', 'HDG', 'ALT', 'NAV', 'VNV', 'APR', 'BC', 'VS', 'FLC', 'NOSE_UP', 'NOSE_DN']) expect(keys).toContain(`button:${b}`);
    for (const k of ['NAV_VOL', 'NAV', 'HDG', 'ALT', 'COM_VOL', 'COM', 'CRS_BARO', 'RANGE', 'FMS']) expect(keys).toContain(`knob:${k}`);
    expect(regions.length).toBe(12 + 20 + 9);
  });

  it('maps the centre of every region back to its control, inside the canvas and outside the screen (except softkey labels)', () => {
    for (const g of regions) {
      const [x, y] = centre(g);
      const h = hitTest(regions, x, y)!;
      expect(controlKey(h.control)).toBe(controlKey(g.control));
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(BEZEL.width);
      expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(BEZEL.height);
      const inScreen = x > BEZEL.screenX && x < BEZEL.screenX + BEZEL.screenW && y > BEZEL.screenY && y < BEZEL.screenY + 738;
      expect(inScreen).toBe(false);
    }
    // no two regions overlap at their centres, and the screen centre hits nothing
    expect(hitTest(regions, BEZEL.screenX + 512, BEZEL.screenY + 384)).toBeNull();
  });

  it('dual knobs: inner ring at the centre, outer ring near the rim; single knobs always inner', () => {
    for (const id of ['NAV', 'COM', 'ALT', 'CRS_BARO', 'FMS']) {
      const g = find(regions, `knob:${id}`);
      if (g.shape !== 'circle') throw new Error('circle expected');
      expect(hitTest(regions, g.cx, g.cy)!.ring).toBe('inner');
      expect(hitTest(regions, g.cx + (g.rInner + g.r) / 2, g.cy)!.ring).toBe('outer');
      expect(hitTest(regions, g.cx + g.r * 1.2, g.cy)?.control.kind === 'knob' && controlKey(hitTest(regions, g.cx + g.r * 1.2, g.cy)!.control) === `knob:${id}`).toBe(false);
    }
    const hdg = find(regions, 'knob:HDG');
    if (hdg.shape !== 'circle') throw new Error('circle expected');
    expect(hitTest(regions, hdg.cx + hdg.r * 0.9, hdg.cy)!.ring).toBe('inner');
  });

  it('softkey regions cover the on-screen label and the physical key below it, left to right', () => {
    for (let i = 0; i < 12; i++) {
      const g = find(regions, `softkey:${i}`);
      if (g.shape !== 'rect') throw new Error('rect expected');
      expect(g.y).toBeLessThanOrEqual(BEZEL.screenY + 738);
      expect(g.y + g.h).toBeGreaterThanOrEqual(BEZEL.keyY + BEZEL.keyH);
      expect(g.x).toBeCloseTo(BEZEL.screenX + (i * 1024) / 12, 6);
    }
  });

  it('scales with the canvas, and without a bezel only the on-screen softkeys remain', () => {
    const half = bezelRegions(BEZEL.width / 2, BEZEL.height / 2);
    const fms = find(half, 'knob:FMS'), full = find(regions, 'knob:FMS');
    if (fms.shape !== 'circle' || full.shape !== 'circle') throw new Error('circle expected');
    expect(fms.cx).toBeCloseTo(full.cx / 2, 6);
    expect(fms.r).toBeCloseTo(full.r / 2, 6);
    const bare = bezelRegions(1024, 768, false);
    expect(bare.length).toBe(12);
    expect(controlKey(hitTest(bare, 1024 * (4.5 / 12), 752)!.control)).toBe('softkey:4');
    expect(hitTest(bare, 512, 300)).toBeNull();
  });
});

describe('wheel deltas', () => {
  it('one notch per 100 px (Chromium), 3 lines (Firefox) or a page; up = clockwise', () => {
    const w = new WheelAccumulator();
    expect(w.steps('a', -100)).toBe(1);
    expect(w.steps('a', 100)).toBe(-1);
    expect(w.steps('a', -300)).toBe(3);
    expect(w.steps('a', -3, 1)).toBe(1);
    expect(w.steps('a', 6, 1)).toBe(-2);
    expect(w.steps('a', -1, 2)).toBe(1);
    expect(w.steps('a', -100000)).toBe(10); // capped
    expect(w.steps('a', 0)).toBe(0);
    expect(w.steps('a', Number.NaN)).toBe(0);
  });

  it('accumulates trackpad fractions per control, any single event ≥ 0.3 notch turns one detent', () => {
    const w = new WheelAccumulator();
    let n = 0;
    for (let i = 0; i < 10; i++) n += w.steps('k', -12); // 120 px of small deltas
    expect(n).toBe(1);
    expect(w.steps('k', -40)).toBe(1); // a lone 40 px event still clicks
    expect(w.steps('k', -60)).toBe(1);
    // switching controls or reversing drops the remainder
    w.steps('k', -90);
    expect(w.steps('other', -12)).toBe(0);
    expect(w.steps('other', 50)).toBe(-1);
  });

  it('G1000.wheel turns the knob under the pointer: ring from the hit, outer forced by the option', () => {
    const r = makeRig(nav);
    const hdg = find(r.g.bezelHitRegions.pfd, 'knob:HDG') as Extract<HitRegion, { shape: 'circle' }>;
    r.cmds.length = 0;
    expect(r.g.wheel('pfd', hdg.cx, hdg.cy, -100)).toBe(true);
    expect(r.g.wheel('pfd', hdg.cx, hdg.cy, 200)).toBe(true);
    const alt = find(r.g.bezelHitRegions.pfd, 'knob:ALT') as Extract<HitRegion, { shape: 'circle' }>;
    r.g.wheel('pfd', alt.cx, alt.cy, -100);
    r.g.wheel('pfd', alt.cx, alt.cy, -100, { outer: true });
    r.g.wheel('pfd', alt.cx + (alt.r + alt.rInner) / 2, alt.cy, 100);
    expect(r.cmds.map((c) => (c.kind === 'action' ? `${c.action}x${c.count}` : c.kind))).toEqual(['headingBugIncx1', 'headingBugDecx2', 'apAltIncx1', 'apAltIncx10', 'apAltDecx10']);
    // not over a knob: not consumed (the camera may zoom)
    const ent = find(r.g.bezelHitRegions.pfd, 'button:ENT') as Extract<HitRegion, { shape: 'rect' }>;
    expect(r.g.wheel('pfd', ent.x + 2, ent.y + 2, -100)).toBe(false);
    expect(r.g.wheel('pfd', 700, 400, -100)).toBe(false);
    // the MFD range knob through the wheel
    const rng = find(r.g.bezelHitRegions.mfd, 'knob:RANGE') as Extract<HitRegion, { shape: 'circle' }>;
    const before = r.g.rangeNm;
    r.g.wheel('mfd', rng.cx, rng.cy, 100);
    expect(r.g.rangeNm).toBeLessThan(before);
  });
});

describe('clicks and hover', () => {
  it('click presses keys and softkeys and pushes knobs at canvas coordinates', () => {
    const r = makeRig(nav, ['KSFO', 'KOAK']);
    const regions = r.g.bezelHitRegions.mfd;
    const at = (key: string) => { const [x, y] = centre(find(regions, key)); return r.g.click('mfd', x, y); };
    expect(at('button:FPL')).toBe(true);
    expect(r.f.mfdGroup).toBe(1);
    expect(at('knob:FMS')).toBe(true); // push → cursor
    expect(r.f.fplPage.cursor).toBe(true);
    expect(at('button:DIRECT')).toBe(true);
    expect(r.f.mfdPopups.at(-1)!.kind).toBe('direct');
    const [sx, sy] = centre(find(r.g.bezelHitRegions.pfd, 'softkey:4'));
    expect(r.g.click('pfd', sx, sy)).toBe(true); // CDI
    expect(r.g.cdiSource).toBe('NAV1');
    expect(r.g.click('pfd', 5, 5)).toBe(false);
  });

  it('hover highlights the control on the bezel (redrawn at once) and returns its tooltip', () => {
    const r = makeRig(nav);
    r.frame(3);
    const [x, y] = centre(find(r.g.bezelHitRegions.pfd, 'knob:CRS_BARO'));
    const t = r.g.hover('pfd', x, y)!;
    expect(t.title).toBe('Course / baro');
    expect(t.hint).toContain('altimeter');
    r.g.update(r.s, 0.001); // well inside the 30 Hz period: the bezel highlight still repaints
    expect(r.g.changed.pfd).toBe(true);
    const [kx, ky] = centre(find(r.g.bezelHitRegions.pfd, 'softkey:4'));
    expect(r.g.hover('pfd', kx, ky)!.title).toBe('Softkey CDI');
    expect(r.g.hover('pfd', NaN, NaN)).toBeNull();
  });
});

describe('G1000Panel (one texture for both displays)', () => {
  it('lays the displays out side by side with a 6 % gap and maps UV back to display pixels', () => {
    const factory = new MockCanvasFactory();
    const g = new G1000({ nav, createCanvas: (w, h) => factory.create(w, h) });
    const p = new G1000Panel(g, { createCanvas: (w, h) => factory.create(w, h) });
    expect(p.gap).toBe(81);
    expect([p.canvas.width, p.canvas.height]).toEqual([1344 * 2 + 81, 1008]);
    expect(p.canvas.width / p.canvas.height).toBeCloseTo(0.96 / 0.35, 2); // the cockpit's G1000 mesh aspect
    expect(p.fromUv(0, 1)).toEqual({ display: 'pfd', x: 0, y: 0 });
    expect(p.fromUv(1, 0)).toEqual({ display: 'mfd', x: 1344, y: 1008 });
    expect(p.fromUv(1384 / p.canvas.width, 0.5)).toBeNull(); // the gap
    expect(p.fromUv(-0.1, 0.5)).toBeNull();
    // the MFD's D→ key through UV
    const d = find(g.bezelHitRegions.mfd, 'button:DIRECT') as Extract<HitRegion, { shape: 'rect' }>;
    const u = (1344 + 81 + d.x + d.w / 2) / p.canvas.width, v = 1 - (d.y + d.h / 2) / p.canvas.height;
    expect(p.click(u, v)).toBe(true);
    expect(g.fms.mfdPopups.at(-1)!.kind).toBe('direct');
    expect(p.hover(u, v)!.display).toBe('mfd');
    // compose copies only what changed
    const ctx = (p.canvas as unknown as { ctx: MockContext2D }).ctx;
    const s = makeRig(nav).s;
    g.update(s, 0.1);
    expect(p.compose()).toBe(true);
    ctx.clear();
    g.update(s, 0.001);
    expect(p.compose()).toBe(false);
    expect(ctx.count('drawImage')).toBe(0);
  });
});
