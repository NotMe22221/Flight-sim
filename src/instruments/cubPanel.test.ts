/**
 * The Super Cub panel ('cub-steam'): layout sanity, markings from the PA-18-150 configuration,
 * power logic on its 14 V system (the real flight model's electrical state and the fallback bus),
 * fuel senders for its 18 gal tanks, hit-testing, and that the C172S panel is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { defaultControlInputs } from '../core/types';
import { AVGAS_KG_PER_GAL } from '../core/units';
import { C172S } from '../fdm/aircraft/c172';
import { PA18_150 } from '../fdm/aircraft/cub';
import { Fdm } from '../fdm/fdm';
import { KSFO, makeEnv } from '../fdm/testing';
import { ASI_DIAL, C172S_VSPEEDS } from './c172';
import { CUB_ASI_DIAL, CUB_STEAM_LAYOUT, cubPanelSpec } from './cub';
import { magKeyDeg } from './gauges/switches';
import { C172S_PANEL_SPEC, instrumentConfigFor, voltmeterScale } from './panelSpec';
import { hasAutopilot, panelSpecFor, steamLayoutFor } from './panels';
import { defaultInstrumentConfig, InstrumentModel } from './readings';
import { asiNeedleDeg, asiNeedleOnDial } from './scales';
import { C172_STEAM_LAYOUT, hitTestPanel, itemHeight, SteamPanel, type GaugeId, type PanelLayout } from './SteamPanel';
import { MockCanvasFactory, type MockContext2D } from './testing/mockCanvas';
import { makeSampleSnapshot } from './testing/sampleSnapshot';

const C172S_G1000 = { ...C172S, id: 'c172s-g1000', panel: 'c172-g1000' as const };

function overlaps(L: PanelLayout): string[] {
  const out: string[] = [];
  for (let i = 0; i < L.items.length; i++) {
    for (let j = i + 1; j < L.items.length; j++) {
      const a = L.items[i], b = L.items[j];
      const ah = itemHeight(a), bh = itemHeight(b);
      if (a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + bh && b.y < a.y + ah) out.push(`${a.id}/${b.id}`);
    }
  }
  return out;
}

describe('Super Cub panel layout', () => {
  const L = CUB_STEAM_LAYOUT;

  it('fits the 1024×512 texture without overlaps and has what a Super Cub has (no gyros, no autopilot unit)', () => {
    expect(L.width).toBe(1024);
    expect(L.height).toBe(512);
    for (const it of L.items) {
      expect(it.x, it.id).toBeGreaterThanOrEqual(0);
      expect(it.y, it.id).toBeGreaterThanOrEqual(0);
      expect(it.x + it.size, it.id).toBeLessThanOrEqual(L.width);
      expect(it.y + itemHeight(it), it.id).toBeLessThanOrEqual(L.height);
    }
    expect(overlaps(L)).toEqual([]);
    const ids = new Set(L.items.map((i) => i.id));
    expect(ids.size).toBe(L.items.length);
    for (const id of ['asi', 'alt', 'vsi', 'tc', 'tach', 'oilT', 'oilP', 'volts', 'fuelL', 'fuelR', 'compass', 'mags', 'master', 'carbHeat', 'primer', 'navcom', 'xpdr', 'warn'] as GaugeId[]) expect(ids.has(id), id).toBe(true);
    for (const id of ['ai', 'hi', 'radios', 'suction', 'flaps'] as GaugeId[]) expect(ids.has(id), id).toBe(false);
    // the primary instruments are the big ones
    const size = (id: GaugeId) => L.items.find((i) => i.id === id)!.size;
    expect(size('asi')).toBeGreaterThanOrEqual(180);
    expect(size('alt')).toBeGreaterThanOrEqual(180);
    expect(size('tach')).toBeGreaterThanOrEqual(170);
  });

  it('every item draws (gauge or radio) and the panel paints without throwing, balanced', () => {
    const f = new MockCanvasFactory();
    const panel = new SteamPanel({ layout: L, spec: cubPanelSpec(PA18_150), factory: f });
    for (const it of L.items) expect(it.id === 'navcom' || it.id === 'xpdr' || !!panel.gauges[it.id], it.id).toBe(true);
    const snap = makeSampleSnapshot();
    panel.update(snap, 1 / 30);
    panel.drawNow();
    const ctx = (panel.canvas as unknown as { ctx: MockContext2D }).ctx;
    expect(ctx.balanced).toBe(true);
    const texts = ctx.texts();
    expect(texts).toContain('PIPER  SUPER CUB');
    expect(texts.some((t) => t.startsWith('MANEUVERING SPEED 80 KIAS'))).toBe(true);
    expect(texts).toContain('COM1');
    expect(texts).toContain('XPDR');
    panel.dispose();
  });

  it('hit-tests by real footprints: NAV/COM rows, the master/radio rockers, bare panel', () => {
    const at = (id: GaugeId, fu: number, fv: number) => { const it = L.items.find((i) => i.id === id)!; return hitTestPanel(L, it.x + fu * it.size, it.y + fv * itemHeight(it)); };
    const com = at('navcom', 0.5, 0.25)!, nav = at('navcom', 0.5, 0.75)!;
    expect(com.item.id).toBe('navcom');
    expect(com.v).toBeLessThan(0.5);
    expect(nav.v).toBeGreaterThan(0.5);
    expect(at('master', 0.25, 0.5)!.u).toBeLessThan(0.5);
    expect(at('master', 0.75, 0.5)!.u).toBeGreaterThan(0.5);
    // the compass strip is 0.42 × its width tall: just below it is the tachometer, not the compass
    const comp = L.items.find((i) => i.id === 'compass')!;
    expect(hitTestPanel(L, comp.x + 90, comp.y + itemHeight(comp) + 20)!.item.id).toBe('tach');
    expect(hitTestPanel(L, 520, 500)).toBeNull();
    // C172: the radio stack below the compass is no longer shadowed by the compass's square box
    expect(hitTestPanel(C172_STEAM_LAYOUT, 600, 150)!.item.id).toBe('radios');
  });
});

describe('Super Cub markings come from its configuration', () => {
  const spec = cubPanelSpec(PA18_150);

  it('V-speed arcs from the PA-18-150 limits on a 20–140 kt dial', () => {
    const l = PA18_150.limits;
    expect(spec.vspeeds).toMatchObject({ vso: l.VsoKt, vs1: l.Vs1Kt, vfe: l.VfeKt[l.VfeKt.length - 1], vno: l.VnoKt, vne: l.VneKt, va: l.VaKt, vy: l.VyKt, vx: l.VxKt });
    expect(spec.vspeeds.vso).toBeLessThan(spec.vspeeds.vs1);
    expect(spec.vspeeds.vfe).toBeLessThan(spec.vspeeds.vno);
    expect(spec.vspeeds.vno).toBeLessThan(spec.vspeeds.vne);
    expect(spec.asiDial).toBe(CUB_ASI_DIAL);
    expect(CUB_ASI_DIAL.maxKt).toBeGreaterThan(l.VneKt);
    expect(CUB_ASI_DIAL.kneeKt).toBeLessThan(l.VsoKt);
    // the needle moves monotonically over the whole marked range and stays on the dial
    let prev = -Infinity;
    for (let kt = 0; kt <= 140; kt += 5) { const a = asiNeedleOnDial(CUB_ASI_DIAL, kt); expect(a).toBeGreaterThan(prev); prev = a; }
    expect(asiNeedleOnDial(CUB_ASI_DIAL, 140) - asiNeedleOnDial(CUB_ASI_DIAL, 0)).toBeCloseTo(340, 6);
    // the C172 dial is untouched
    expect(asiNeedleDeg(120)).toBeCloseTo(asiNeedleOnDial(ASI_DIAL, 120), 9);
    expect(asiNeedleDeg(120)).toBeCloseTo(170, 9);
  });

  it('tachometer red line at 2,700 rpm, 18 gal tank gauges, 14 V bus with its own thresholds, no autopilot', () => {
    expect(spec.tach.redline).toBe(PA18_150.limits.redlineRPM);
    expect(spec.tach.greenHi).toBe(2700);
    expect(spec.oilPress.redLo).toBe(25);
    expect(spec.oilPress.yellow?.length).toBe(2);
    expect(spec.fuel.maxGal).toBe(18);
    expect(spec.fuel.unusableGalPerTank).toBeCloseTo(0.1, 3);
    const e = PA18_150.electrical!;
    expect(spec.electrical.nominalV).toBe(14);
    expect(spec.electrical.busV).toBe(e.regulatorV);
    expect(spec.electrical.lowVoltsV).toBe(e.lowVoltsV);
    expect(spec.electrical.busLiveV).toBe(e.dropOutV);
    expect(spec.electrical.voltmeter).toEqual(voltmeterScale(14));
    expect(spec.electrical.voltmeter.min).toBe(8);
    expect(spec.electrical.voltmeter.max).toBe(16);
    expect(spec.autopilot).toBe(false);
    expect(hasAutopilot(PA18_150)).toBe(false);
  });

  it('the 172S (steam and G1000) keeps its historical panel and constants', () => {
    expect(panelSpecFor(C172S)).toBe(C172S_PANEL_SPEC);
    expect(panelSpecFor(C172S_G1000)).toBe(C172S_PANEL_SPEC);
    expect(steamLayoutFor(C172S)).toBe(C172_STEAM_LAYOUT);
    expect(steamLayoutFor(C172S_G1000)).toBe(C172_STEAM_LAYOUT);
    expect(steamLayoutFor(PA18_150)).toBe(CUB_STEAM_LAYOUT);
    expect(hasAutopilot(C172S)).toBe(true);
    expect(C172S_PANEL_SPEC.vspeeds).toBe(C172S_VSPEEDS);
    expect(instrumentConfigFor(C172S_PANEL_SPEC)).toEqual(defaultInstrumentConfig());
  });

  it('the magneto key turns OFF → R → L → BOTH → START', () => {
    const a = [0, 1, 2, 3].map((m) => magKeyDeg(m, false));
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThan(a[i - 1]);
    expect(magKeyDeg(3, true)).toBeGreaterThan(a[3]);
  });
});

describe('Super Cub instrument power follows its 14 V system', () => {
  const spec = cubPanelSpec(PA18_150);

  it('with the real flight model: battery only lights LOW VOLTS at ≈12 V, the alternator clears it at ≈14 V, master off is dark', () => {
    const env = makeEnv();
    const f = new Fdm(PA18_150, { seed: 1 });
    f.setFuelFraction(1);
    f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: false }, env);
    const u = defaultControlInputs();
    u.magnetos = 0; u.mixture = 0; u.masterBattery = false; u.masterAlternator = false; u.avionicsMaster = false;
    const model = new InstrumentModel(instrumentConfigFor(spec));
    const snap = makeSampleSnapshot();
    const read = (seconds: number) => {
      for (let t = 0; t < seconds; t += 1 / 120) f.step(1 / 120, u, env);
      snap.aircraft = f.state; snap.inputs = u;
      for (let i = 0; i < 30; i++) model.update(snap, 1 / 30);
      return model.readings;
    };
    let r = read(0.5);
    expect(r.voltsV).toBe(0);
    expect(r.essentialOn).toBe(false);
    expect(r.annunciators.lowVolts).toBe(false);
    expect(r.turn.valid).toBe(false);
    u.masterBattery = true; u.masterAlternator = true; u.avionicsMaster = true;
    r = read(2);
    expect(f.state.electrical?.nominalVolts).toBe(14);
    expect(r.voltsV).toBeGreaterThan(11);
    expect(r.voltsV).toBeLessThan(spec.electrical.lowVoltsV);
    expect(r.essentialOn).toBe(true);
    expect(r.avionicsOn).toBe(true);
    expect(r.annunciators.lowVolts).toBe(true);
    // start the engine: the alternator regulates the bus at 14.2 V
    u.mixture = 1; u.magnetos = 3; u.throttle = 0.15; u.starter = true;
    for (let t = 0; t < 6 && !f.state.engine.running; t += 1 / 120) f.step(1 / 120, u, env);
    u.starter = false;
    expect(f.state.engine.running).toBe(true);
    u.throttle = 0.3;
    r = read(20);
    expect(r.voltsV).toBeGreaterThan(13.5);
    expect(r.voltsV).toBeLessThan(15);
    expect(r.annunciators.lowVolts).toBe(false);
  });

  it('the fallback bus (no FDM electrical state) is a 14 V bus for the Cub and stays 28 V for the 172', () => {
    const cub = new InstrumentModel(instrumentConfigFor(spec));
    const c172 = new InstrumentModel();
    const snap = makeSampleSnapshot();
    snap.aircraft.electrical = undefined;
    snap.aircraft.engine.running = false; snap.aircraft.engine.rpm = 0;
    snap.inputs.masterBattery = true; snap.inputs.masterAlternator = true; snap.inputs.avionicsMaster = true;
    for (let i = 0; i < 60; i++) { cub.update(snap, 1 / 30); c172.update(snap, 1 / 30); }
    expect(cub.readings.voltsV).toBeGreaterThan(10);
    expect(cub.readings.voltsV).toBeLessThan(13);
    expect(cub.readings.essentialOn).toBe(true); // above the 9 V drop-out, not the 172's 20 V
    expect(cub.readings.annunciators.lowVolts).toBe(true);
    expect(c172.readings.voltsV).toBeGreaterThan(22);
    snap.aircraft.engine.running = true; snap.aircraft.engine.rpm = 2000;
    for (let i = 0; i < 90; i++) { cub.update(snap, 1 / 30); c172.update(snap, 1 / 30); }
    expect(cub.readings.voltsV).toBeCloseTo(spec.electrical.busV, 1);
    expect(cub.readings.annunciators.lowVolts).toBe(false);
    expect(c172.readings.voltsV).toBeCloseTo(28, 1);
  });

  it('the radios are dark while the radio bus is unpowered', () => {
    const panel = new SteamPanel({ layout: CUB_STEAM_LAYOUT, spec, factory: new MockCanvasFactory() });
    const snap = makeSampleSnapshot();
    if (snap.aircraft.electrical) { snap.aircraft.electrical.avionicsPowered = false; }
    snap.inputs.avionicsMaster = false;
    panel.reset(snap);
    panel.update(snap, 1 / 30);
    panel.drawNow();
    const ctx = (panel.canvas as unknown as { ctx: MockContext2D }).ctx;
    expect(ctx.texts()).not.toContain('COM1');
    expect(ctx.texts()).not.toContain('XPDR');
    panel.dispose();
  });

  it('fuel gauges read the 18 gal wing tanks (0.1 gal unusable), not the 172\'s 26 gal tanks', () => {
    const cub = new InstrumentModel(instrumentConfigFor(spec));
    const snap = makeSampleSnapshot();
    snap.aircraft.fuelKg = [18 * AVGAS_KG_PER_GAL, 9 * AVGAS_KG_PER_GAL];
    snap.aircraft.euler = [0, 0, 0];
    cub.reset(snap);
    for (let i = 0; i < 300; i++) cub.update(snap, 1 / 30);
    expect(cub.readings.fuelGal[0]).toBeGreaterThan(17.5);
    expect(cub.readings.fuelGal[0]).toBeLessThanOrEqual(18);
    expect(cub.readings.fuelGal[1]).toBeGreaterThan(8.5);
    expect(cub.readings.fuelGal[1]).toBeLessThan(9.5);
  });
});

describe('HUD idle repaint', () => {
  it('a visible HUD repaints at least once a second even when nothing changed (stale canvas content)', async () => {
    const { Hud } = await import('./Hud');
    const f = new MockCanvasFactory();
    const hud = new Hud({ createCanvas: (w, h) => f.create(w, h) });
    const s = makeSampleSnapshot();
    s.camera.mode = 'cockpit';
    hud.update(s, 0.05);
    expect(hud.drawn).toBe(true);
    let draws = 0;
    for (let i = 0; i < 40; i++) { hud.update(s, 0.05); if (hud.drawn) draws++; } // 2 s unchanged
    expect(draws).toBeGreaterThanOrEqual(1);
    expect(draws).toBeLessThanOrEqual(2);
    hud.setVisible(false);
    hud.update(s, 0.05);
    draws = 0;
    for (let i = 0; i < 40; i++) { hud.update(s, 0.05); if (hud.drawn) draws++; }
    expect(draws).toBe(0); // hidden: cleared once, then nothing
  });
});
