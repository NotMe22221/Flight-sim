import { describe, expect, it } from 'vitest';
import { defaultControlInputs } from '../core/types';
import { DEFAULT_CONTROL_RATES, type LeverAxis, type MapperContext, applyControlAction, rampToward } from './controlsMapper';

const ctx = (flapDetents = 4, locked: LeverAxis[] = []): MapperContext =>
  ({ flapDetents, rates: { ...DEFAULT_CONTROL_RATES }, leverFree: (a) => !locked.includes(a) });

describe('applyControlAction', () => {
  it('flaps step and clamp to the detent count', () => {
    const c = defaultControlInputs();
    for (let i = 0; i < 10; i++) applyControlAction(c, 'flapsDown', ctx(4));
    expect(c.flapsIndex).toBe(3);
    applyControlAction(c, 'flapsUp', ctx(4));
    expect(c.flapsIndex).toBe(2);
    applyControlAction(c, 'flapsRetract', ctx(4));
    applyControlAction(c, 'flapsUp', ctx(4));
    expect(c.flapsIndex).toBe(0);
    applyControlAction(c, 'flapsFull', ctx(1)); // aircraft without flaps
    expect(c.flapsIndex).toBe(0);
  });

  it('magnetos wrap both ways through 0..3', () => {
    const c = defaultControlInputs();
    const seq: number[] = [];
    for (let i = 0; i < 5; i++) { applyControlAction(c, 'magnetosNext', ctx()); seq.push(c.magnetos); }
    expect(seq).toEqual([0, 1, 2, 3, 0]);
    applyControlAction(c, 'magnetosPrev', ctx());
    expect(c.magnetos).toBe(3);
  });

  it('throttle steps are exact, clamp, and are ignored while an analog lever owns the axis', () => {
    const c = defaultControlInputs();
    for (let i = 0; i < 20; i++) applyControlAction(c, 'throttleInc', ctx());
    expect(c.throttle).toBe(1);
    applyControlAction(c, 'throttleDecSmall', ctx());
    expect(c.throttle).toBe(0.99);
    applyControlAction(c, 'throttleCut', ctx(4, ['throttle']));
    expect(c.throttle).toBe(0.99);
    applyControlAction(c, 'mixtureLean', ctx(4, ['throttle']));
    expect(c.mixture).toBe(0);
  });

  it('toggles and trims; sim-level actions are not control actions', () => {
    const c = defaultControlInputs();
    expect(applyControlAction(c, 'parkingBrakeToggle', ctx())).toBe(true);
    expect(c.parkingBrake).toBe(false);
    applyControlAction(c, 'lightsPanel', ctx());
    expect(c.lights.panel).toBe(1);
    for (let i = 0; i < 150; i++) applyControlAction(c, 'trimNoseUp', ctx());
    expect(c.pitchTrim).toBe(1);
    applyControlAction(c, 'aileronTrimRight', ctx());
    expect(c.aileronTrim).toBe(0.01);
    expect(applyControlAction(c, 'cameraNext', ctx())).toBe(false);
    expect(applyControlAction(c, 'apToggle', ctx())).toBe(false);
    expect(applyControlAction(c, 'brakesHold', ctx())).toBe(true);
  });

  it('rampToward moves at the configured rates and stops at the target', () => {
    expect(rampToward(0, 1, 0.125, 0.25, 0.15)).toBeCloseTo(0.5, 12);
    expect(rampToward(0.9, 1, 0.125, 0.25, 0.15)).toBe(1);
    expect(rampToward(1, 0, 0.075, 0.25, 0.15)).toBeCloseTo(0.5, 12);
    expect(rampToward(0.3, 0.3, 1, 0.25, 0.15)).toBe(0.3);
  });
});
