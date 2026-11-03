import { describe, expect, it } from 'vitest';
import { defaultControlInputs } from '../core/types';
import { DT, KSFO, makeEnv, makeFdm } from './testing';

function coldStart(master: boolean, charge = 1, seconds = 8) {
  const env = makeEnv();
  const f = makeFdm(1043);
  f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: 0, speedMs: 0, onGround: true, engineRunning: false }, env);
  f.electrical.setCharge(charge);
  const u = defaultControlInputs();
  Object.assign(u, { masterBattery: master, masterAlternator: master, avionicsMaster: false, magnetos: 3, mixture: 1, throttle: 0.1, parkingBrake: true });
  let maxRpm = 0;
  for (let t = 0; t < seconds; t += DT) {
    u.starter = t < 4 && !f.state.engine.running;
    f.step(DT, u, env);
    maxRpm = Math.max(maxRpm, f.state.engine.rpm);
  }
  return { f, maxRpm };
}

describe('engine start through the electrical system', () => {
  it('starts with the master on and a charged battery, then the alternator takes the load', () => {
    const { f } = coldStart(true);
    expect(f.state.engine.running).toBe(true);
    const e = f.state.electrical!;
    expect(e.busVolts).toBeGreaterThan(27.5);
    expect(e.alternatorAmps).toBeGreaterThan(0);
  });

  it('does not crank with the master off (the starter has no power)', () => {
    const { f, maxRpm } = coldStart(false);
    expect(f.state.engine.running).toBe(false);
    expect(maxRpm).toBeLessThan(20);
    expect(f.state.electrical!.busVolts).toBe(0);
  });

  it('does not start on a flat battery', () => {
    const { f } = coldStart(true, 0.03);
    expect(f.state.engine.running).toBe(false);
  });
});
