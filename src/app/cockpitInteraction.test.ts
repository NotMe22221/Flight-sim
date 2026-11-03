/** Clickable-cockpit hit-testing against the current aircraft's panel layout (C172S and Super Cub). */
import { describe, expect, it } from 'vitest';
import { defaultControlInputs } from '../core/types';
import { CUB_STEAM_LAYOUT } from '../instruments/cub';
import { C172_STEAM_LAYOUT, itemHeight, type GaugeId, type PanelLayout } from '../instruments/SteamPanel';
import { KNOBS, pickPanelKnob } from './cockpitInteraction';
import { RadioStack } from './radios';
import type { Simulator } from './Simulator';

const centre = (L: PanelLayout, id: GaugeId, fv = 0.5, fu = 0.5) => {
  const it = L.items.find((i) => i.id === id)!;
  return pickPanelKnob(L, it.x + fu * it.size, it.y + fv * itemHeight(it));
};

describe('cockpit hit-testing per layout', () => {
  it('every Super Cub panel item has a tooltip / control', () => {
    for (const it of CUB_STEAM_LAYOUT.items) {
      const h = centre(CUB_STEAM_LAYOUT, it.id);
      expect(h, it.id).not.toBeNull();
      expect(h!.knob.id).toBe(it.id);
    }
  });

  it('the C172S panel still maps its knobs (altimeter, heading bug, NAV1, flaps)', () => {
    expect(centre(C172_STEAM_LAYOUT, 'alt')!.knob.wheel).toEqual(['altimeterInc', 'altimeterDec']);
    expect(centre(C172_STEAM_LAYOUT, 'hi')!.knob.wheel).toEqual(['headingBugInc', 'headingBugDec']);
    expect(centre(C172_STEAM_LAYOUT, 'radios')!.knob.click).toBe('nav1Swap');
    const flaps = KNOBS.flaps!.click as (v: number, u: number) => string;
    expect(flaps(0.2, 0.5)).toBe('flapsUp');
    expect(flaps(0.8, 0.5)).toBe('flapsDown');
    // no heading indicator / attitude indicator on the Cub panel
    expect(CUB_STEAM_LAYOUT.items.some((i) => i.id === 'hi' || i.id === 'ai')).toBe(false);
  });

  it('Super Cub controls: NAV/COM rows, magneto key, master vs radio rocker, carb heat', () => {
    const com = centre(CUB_STEAM_LAYOUT, 'navcom', 0.25)!, nav = centre(CUB_STEAM_LAYOUT, 'navcom', 0.75)!;
    const click = com.knob.click as (v: number, u: number) => string;
    expect(click(com.v, com.u)).toBe('com1Swap');
    expect(click(nav.v, nav.u)).toBe('nav1Swap');
    const wheel = com.knob.wheel as (v: number) => [string, string] | null;
    expect(wheel(com.v)).toBeNull(); // the COM row tunes through wheelFn (no SimAction for COM standby)
    expect(wheel(nav.v)).toEqual(['nav1Inc', 'nav1Dec']);
    expect(centre(CUB_STEAM_LAYOUT, 'mags')!.knob.wheel).toEqual(['magnetosNext', 'magnetosPrev']);
    expect(centre(CUB_STEAM_LAYOUT, 'mags')!.knob.click).toBe('engineAutoStart');
    const m = KNOBS.master!.click as (v: number, u: number) => string;
    expect(m(0.5, centre(CUB_STEAM_LAYOUT, 'master', 0.5, 0.25)!.u)).toBe('masterToggle');
    expect(m(0.5, centre(CUB_STEAM_LAYOUT, 'master', 0.5, 0.75)!.u)).toBe('avionicsMasterToggle');
    expect(centre(CUB_STEAM_LAYOUT, 'carbHeat')!.knob.click).toBe('carbHeat');
  });

  it('the COM row wheel steps the COM1 standby by 25 kHz channels and wraps the band', () => {
    const radios = new RadioStack({} as never);
    const sim = { radios } as unknown as Simulator;
    radios.state.com1.standbyMHz = 120.5;
    KNOBS.navcom!.wheelFn!(sim, 1, 0.2);
    expect(radios.state.com1.standbyMHz).toBeCloseTo(120.525, 6);
    KNOBS.navcom!.wheelFn!(sim, -1, 0.2);
    KNOBS.navcom!.wheelFn!(sim, -1, 0.2);
    expect(radios.state.com1.standbyMHz).toBeCloseTo(120.475, 6);
    // the NAV row is tuned by actions, not by wheelFn
    KNOBS.navcom!.wheelFn!(sim, 1, 0.8);
    expect(radios.state.com1.standbyMHz).toBeCloseTo(120.475, 6);
    radios.state.com1.standbyMHz = 136.975;
    radios.stepComStandby(1);
    expect(radios.state.com1.standbyMHz).toBeCloseTo(118.0, 6);
    radios.stepComStandby(-1);
    expect(radios.state.com1.standbyMHz).toBeCloseTo(136.975, 6);
  });

  it('switch tooltips read the pilot\'s switch positions', () => {
    const controls = defaultControlInputs();
    controls.magnetos = 2; controls.masterBattery = true; controls.avionicsMaster = false; controls.carbHeat = true;
    const sim = { input: { controls } } as unknown as Simulator;
    expect(KNOBS.mags!.value(sim)).toBe('L');
    expect(KNOBS.master!.value(sim)).toBe('MASTER ON · RADIO OFF');
    expect(KNOBS.carbHeat!.value(sim)).toBe('ON (pulled)');
    controls.starter = true;
    expect(KNOBS.mags!.value(sim)).toBe('START');
  });
});
