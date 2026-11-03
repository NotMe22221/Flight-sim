/**
 * The UI for the Super Cub: aircraft facts in the picker, its own checklists (auto-ticked from the
 * sim state, swapped in when the aircraft changes), and the aircraft named on bush-trip cards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C172S } from '../fdm/aircraft/c172';
import { PA18_150 } from '../fdm/aircraft/cub';
import { aircraftBlurb, checklistsFor, gearKind, hasAutopilot, panelKind, seatCount } from './aircraftInfo';
import { C172_CHECKLISTS } from './data/c172Checklists';
import { CUB_CHECKLISTS } from './data/cubChecklists';
import { Checklist } from './flight/Checklist';
import { AUTO_CHECK_IDS, evalAutoCheck } from './flight/checklistAuto';
import { installFakeDom, type FakeDomHandle } from './testing/fakeDom';

let dom: FakeDomHandle;
beforeAll(() => { dom = installFakeDom(); });
afterAll(() => dom.uninstall());

describe('aircraft facts for the picker', () => {
  it('the Super Cub is a two-seat tail-dragger with steam gauges and no autopilot', () => {
    expect(gearKind(PA18_150)).toBe('Tail-wheel');
    expect(gearKind(C172S)).toBe('Tricycle');
    expect(panelKind(PA18_150)).toBe('Steam gauges');
    expect(panelKind({ panel: 'c172-g1000' })).toBe('G1000');
    expect(hasAutopilot(PA18_150)).toBe(false);
    expect(hasAutopilot(C172S)).toBe(true);
    expect(seatCount(PA18_150)).toBe(2);
    expect(seatCount(C172S)).toBeGreaterThanOrEqual(2);
    expect(aircraftBlurb(PA18_150)).toMatch(/tail-dragger/);
  });
});

describe('Super Cub checklists', () => {
  it('cover the phases, have text and responses, and reference existing predicates', () => {
    const ids = CUB_CHECKLISTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const want of ['before-start', 'start', 'taxi', 'runup', 'takeoff', 'cruise', 'before-landing', 'landing', 'shutdown']) expect(ids).toContain(want);
    for (const s of CUB_CHECKLISTS) {
      expect(s.items.length).toBeGreaterThan(0);
      for (const it of s.items) {
        expect(it.text.trim().length).toBeGreaterThan(0);
        expect(it.response.trim().length).toBeGreaterThan(0);
        if (it.auto) expect(AUTO_CHECK_IDS, `${s.id}: ${it.text}`).toContain(it.auto);
      }
    }
    // no autopilot, no electric fuel pump, no avionics bus 1 & 2 in the Cub
    const text = CUB_CHECKLISTS.flatMap((s) => s.items.map((i) => `${i.text} ${i.response}`)).join(' ');
    expect(text).not.toMatch(/autopilot|fuel pump|BUS 1/i);
    expect(checklistsFor(PA18_150)).toBe(CUB_CHECKLISTS);
    expect(checklistsFor(C172S)).toBe(C172_CHECKLISTS);
    expect(checklistsFor(null)).toBe(C172_CHECKLISTS);
  });

  it('new predicates: carb heat and the last of the Cub\'s three flap positions', () => {
    const snap = (o: { carbHeat: boolean; flapsIndex: number }) => ({ inputs: o, aircraft: { onGround: false, aero: { ias: 61 * 0.514444 }, verticalSpeedMs: 2 } }) as never;
    expect(evalAutoCheck('carbHeatOn', snap({ carbHeat: true, flapsIndex: 0 }))).toBe(true);
    expect(evalAutoCheck('carbHeatOff', snap({ carbHeat: true, flapsIndex: 0 }))).toBe(false);
    expect(evalAutoCheck('flapsSecondNotch', snap({ carbHeat: false, flapsIndex: 2 }))).toBe(true);
    expect(evalAutoCheck('flapsSecondNotch', snap({ carbHeat: false, flapsIndex: 1 }))).toBe(false);
    expect(evalAutoCheck('cubClimbSpeed', snap({ carbHeat: false, flapsIndex: 0 }))).toBe(true);
  });

  it('the checklist panel swaps to the Super Cub\'s sections and back', () => {
    const host = document.createElement('div') as unknown as HTMLElement;
    const cl = new Checklist(host);
    expect(cl.sectionList).toBe(C172_CHECKLISTS);
    cl.setSections(CUB_CHECKLISTS);
    expect(cl.section.id).toBe('before-start');
    const opts = [...host.querySelectorAll('option')].map((o) => o.textContent);
    expect(opts).toEqual(CUB_CHECKLISTS.map((s) => s.title));
    cl.goTo(2);
    expect(cl.section.id).toBe('taxi');
    cl.setSections(C172_CHECKLISTS);
    expect(cl.section).toBe(C172_CHECKLISTS[0]);
    expect(host.querySelectorAll('option').length).toBe(C172_CHECKLISTS.length);
  });
});
