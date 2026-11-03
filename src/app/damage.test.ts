import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import { KT } from '../core/units';
import { C172S } from '../fdm/aircraft/c172';
import { StressMonitor, crashIsRecoverable } from './damage';

const L = C172S.limits;

function state(iasKt: number, nz: number, onGround = false) {
  const s = makeAircraftState({ onGround, altitudeAglM: onGround ? 1 : 500 });
  s.aero.ias = iasKt * KT;
  s.loadFactor[2] = nz;
  return s;
}

const run = (m: StressMonitor, s: ReturnType<typeof state>, seconds: number) => {
  let why: string | null = null;
  for (let t = 0; t < seconds && !why; t += 1 / 120) why = m.check(1 / 120, s, L);
  return why;
};

describe('StressMonitor', () => {
  it('breaks the airframe after a second beyond 1.1 Vne, not for a brief excursion or at Vne', () => {
    expect(run(new StressMonitor(), state(L.VneKt, 1), 5)).toBeNull();
    expect(run(new StressMonitor(), state(L.VneKt * 1.15, 1), 0.5)).toBeNull();
    expect(run(new StressMonitor(), state(L.VneKt * 1.15, 1), 1.1)).toMatch(/overspeed/);
  });

  it('breaks the airframe beyond the ultimate load factor in the air only', () => {
    expect(run(new StressMonitor(), state(100, 4.5), 2)).toBeNull(); // above limit (3.8), below ultimate (5.7)
    expect(run(new StressMonitor(), state(100, 6.2), 0.2)).toMatch(/over-G/);
    expect(run(new StressMonitor(), state(100, -2.5), 0.2)).toMatch(/negative G/);
    // a firm landing peaks at ~5-6 g at the CG through the gear: not a structural failure
    expect(run(new StressMonitor(), state(55, 6.5, true), 0.5)).toBeNull();
  });

  it('ignores a single-sample spike', () => {
    const m = new StressMonitor();
    expect(m.check(1 / 120, state(100, 8), L)).toBeNull();
    expect(m.check(1 / 120, state(100, 1), L)).toBeNull();
    expect(run(m, state(100, 1), 1)).toBeNull();
  });
});

describe('crashIsRecoverable', () => {
  it('lets the crash-damage assist clear impacts but never a numerical failure', () => {
    expect(crashIsRecoverable('nose gear collapse')).toBe(true);
    expect(crashIsRecoverable('water landing')).toBe(true);
    expect(crashIsRecoverable('numerical instability')).toBe(false);
  });
});
