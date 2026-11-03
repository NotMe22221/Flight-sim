import { describe, expect, it } from 'vitest';
import { FT, KT } from '../core/units';
import { Hud } from './Hud';
import { tapeLabel } from './hud/flightStrip';
import { hudScale } from './hud/primitives';
import { flapsText, gearText } from './hud/statusStrip';
import { MockCanvas, MockCanvasFactory, type MockContext2D } from './testing/mockCanvas';
import { makeSampleSnapshot } from './testing/sampleSnapshot';

function make(opts: ConstructorParameters<typeof Hud>[0] = {}) {
  const factory = new MockCanvasFactory();
  const hud = new Hud({ createCanvas: (w, h) => factory.create(w, h), ...opts });
  const ctx = (hud.canvas as unknown as MockCanvas).ctx;
  return { hud, ctx };
}

const external = () => { const s = makeSampleSnapshot(); s.camera.mode = 'chase'; return s; };
const joined = (c: MockContext2D): string => c.texts().join('');

describe('Hud', () => {
  it('resize sets the backing store to CSS size × dpr and update does not throw', () => {
    const { hud, ctx } = make();
    hud.resize(1600, 900, 2);
    expect(hud.canvas.width).toBe(3200);
    expect(hud.canvas.height).toBe(1800);
    expect(() => hud.update(external(), 1 / 60)).not.toThrow();
    expect(hud.drawn).toBe(true);
    expect(ctx.balanced).toBe(true);
    const st = ctx.calls.find((c) => c.name === 'setTransform');
    expect(st?.args.slice(0, 4)).toEqual([2, 0, 0, 2]);
    expect(() => hud.resize(Number.NaN, 0, 0)).not.toThrow();
    expect(() => hud.update(external(), 1 / 60)).not.toThrow();
  });

  it('shows airspeed, altitude, heading, VS, AP modes and the controls in external views', () => {
    const { hud, ctx } = make();
    const s = external();
    s.aircraft.verticalSpeedMs = -500 * FT / 60;
    hud.update(s, 1 / 60);
    const t = ctx.texts();
    for (const k of ['IAS', 'ALT', 'GS', 'AP', 'HDG', 'ALT', 'THR', 'MIX', 'FLAPS', 'TRIM', 'GEAR', 'BRAKE', 'DOWN', 'UP']) expect(t).toContain(k);
    const j = joined(ctx);
    expect(j).toContain('110');
    expect(j).toContain('3,500');
    expect(j).toContain('285°');
    expect(j).toContain('-500');
    expect(j).toContain('72%');
  });

  it('hides the flight data in the cockpit but keeps flags and the terrain-loading status', () => {
    const { hud, ctx } = make();
    const s = makeSampleSnapshot();
    s.camera.mode = 'cockpit';
    s.terrainReady = 0.42;
    s.aircraft.aero.stallWarning = true;
    hud.update(s, 0.1);
    const t = ctx.texts();
    expect(t).not.toContain('IAS');
    expect(t).toContain('LOADING TERRAIN');
    expect(joined(ctx)).toContain('42%');
    expect(t).toContain('STALL');
    hud.showInCockpit = true;
    hud.invalidate();
    ctx.clear();
    hud.update(s, 0.1);
    expect(ctx.texts()).toContain('IAS');
  });

  it('caps redraws and skips unchanged frames; hidden HUDs clear once and stop drawing', () => {
    const { hud, ctx } = make();
    const s = external();
    hud.update(s, 1 / 60);
    expect(hud.drawn).toBe(true);
    hud.update(s, 0.01);
    expect(hud.drawn).toBe(false); // within 1/30 s
    hud.update(s, 0.05);
    expect(hud.drawn).toBe(false); // due, but nothing changed
    s.aircraft.aero.ias = 120 * KT;
    for (let i = 0; i < 10; i++) hud.update(s, 0.05);
    expect(joined(ctx)).toContain('120');
    hud.setVisible(false);
    ctx.clear();
    hud.update(s, 0.05);
    expect(hud.drawn).toBe(true);
    expect(ctx.count('clearRect')).toBe(1);
    expect(ctx.count('fillText')).toBe(0);
    hud.update(s, 0.05);
    expect(hud.drawn).toBe(false);
  });

  it('shows warnings, pause, slew, parking brake and a custom status line', () => {
    const { hud, ctx } = make();
    const s = external();
    Object.assign(s.aircraft.warnings, { overspeed: true, overG: true, lowFuel: true });
    s.paused = true; s.slew = true; s.inputs.parkingBrake = true;
    hud.setStatus('Loading imagery');
    hud.update(s, 1 / 60);
    const t = ctx.texts();
    for (const k of ['OVERSPEED', 'OVER-G', 'LOW FUEL', 'PAUSED', 'SLEW', 'PARK', 'Loading imagery']) expect(t).toContain(k);
    expect(hud.status).toBe('Loading imagery');
  });

  it('dispose releases the canvas and later updates are ignored', () => {
    const { hud } = make();
    hud.dispose();
    expect(hud.canvas.width).toBe(0);
    expect(() => hud.update(external(), 1 / 60)).not.toThrow();
    expect(hud.drawn).toBe(false);
  });
});

describe('HUD helpers', () => {
  it('labels the heading tape with cardinals and tens, wrapping negative headings', () => {
    expect(tapeLabel(0)).toBe('N');
    expect(tapeLabel(360)).toBe('N');
    expect(tapeLabel(90)).toBe('E');
    expect(tapeLabel(-90)).toBe('W');
    expect(tapeLabel(280)).toBe('28');
    expect(tapeLabel(-20)).toBe('34');
  });
  it('formats flaps and gear and scales with the viewport', () => {
    expect(flapsText(0)).toBe('UP');
    expect(flapsText(10.2)).toBe('10°');
    expect(gearText(1).text).toBe('DOWN');
    expect(gearText(0).text).toBe('UP');
    expect(gearText(0.5).text).toBe('TRANSIT');
    expect(hudScale(1800, 1200)).toBeCloseTo(1.6);
    expect(hudScale(390, 844)).toBeCloseTo((390 - 24) / 620); // width-limited portrait phone
    expect(hudScale(320, 200)).toBe(0.45);
    expect(hudScale(1280, 720)).toBeCloseTo(1.2);
    expect(hudScale(900, 600, 1.2)).toBeCloseTo(1.2);
  });
});
