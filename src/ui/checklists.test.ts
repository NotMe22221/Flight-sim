import { describe, expect, it } from 'vitest';
import { C172_CHECKLISTS, C172_EMERGENCY } from './data/c172Checklists';
import { AUTO_CHECKS, AUTO_CHECK_IDS, evalAutoCheck } from './flight/checklistAuto';

describe('C172 checklist data', () => {
  it('has non-empty sections with text and response on every item', () => {
    expect(C172_CHECKLISTS.length).toBeGreaterThanOrEqual(12);
    for (const s of [...C172_CHECKLISTS, ...C172_EMERGENCY]) {
      expect(s.id).toBeTruthy();
      expect(s.title).toBeTruthy();
      expect(s.items.length).toBeGreaterThan(0);
      for (const it of s.items) {
        expect(it.text.trim().length, `${s.id}: text`).toBeGreaterThan(0);
        expect(it.response.trim().length, `${s.id}: response for ${it.text}`).toBeGreaterThan(0);
      }
    }
  });
  it('section ids are unique and cover the POH phases', () => {
    const ids = C172_CHECKLISTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const want of ['before-start', 'start', 'runup', 'takeoff', 'cruise', 'before-landing', 'landing', 'securing']) expect(ids).toContain(want);
  });
  it('every auto id references an existing predicate', () => {
    for (const s of [...C172_CHECKLISTS, ...C172_EMERGENCY]) for (const it of s.items) if (it.auto) expect(AUTO_CHECK_IDS, `${s.id}: ${it.text}`).toContain(it.auto);
  });
  it('predicates tolerate a missing snapshot and evaluate simple states', () => {
    expect(evalAutoCheck('flapsUp', null)).toBe(false);
    const snap = {
      inputs: { parkingBrake: true, flapsIndex: 0, magnetos: 3, mixture: 1, throttle: 0, fuelSelector: 'both', brakeLeft: 0, brakeRight: 0, pitchTrim: 0, pitotHeat: false,
        lights: { nav: true, beacon: true, strobe: false, landing: false, taxi: false, panel: 0 } },
      aircraft: { engine: { running: true, rpm: 1800, oilPressurePa: 300_000 }, onGround: true, aero: { ias: 0 }, verticalSpeedMs: 0, qnhSetPa: 101325 },
      autopilot: { engaged: false },
      weather: { qnhPa: 101325 },
    } as never;
    expect(evalAutoCheck('parkingBrakeSet', snap)).toBe(true);
    expect(evalAutoCheck('flapsUp', snap)).toBe(true);
    expect(evalAutoCheck('magnetosBoth', snap)).toBe(true);
    expect(evalAutoCheck('engineRunning', snap)).toBe(true);
    expect(evalAutoCheck('throttleRunup', snap)).toBe(true);
    expect(evalAutoCheck('mixtureRich', snap)).toBe(true);
    expect(evalAutoCheck('strobeOn', snap)).toBe(false);
    expect(evalAutoCheck('altimeterSet', snap)).toBe(true);
    expect(evalAutoCheck('airborne', snap)).toBe(false);
    expect(Object.keys(AUTO_CHECKS).length).toBe(AUTO_CHECK_IDS.length);
  });
});
