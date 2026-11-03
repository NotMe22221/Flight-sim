import { describe, expect, it } from 'vitest';
import { C172S_ELECTRICAL, ElectricalSystem, type ElectricalLoads, type ElectricalSwitches } from './electrical';

const ON: ElectricalSwitches = { battery: true, alternator: true, avionics: true };
const loads = (o: Partial<ElectricalLoads> = {}): ElectricalLoads => ({
  nav: true, beacon: true, strobe: false, landing: false, taxi: false, panel: 0, pitotHeat: false, fuelPump: false, starter: false, ...o,
});
const run = (e: ElectricalSystem, seconds: number, sw: ElectricalSwitches, l: ElectricalLoads, rpm: number) => {
  for (let t = 0; t < seconds; t += 0.1) e.step(0.1, sw, l, rpm);
  return e.state;
};

describe('C172S electrical system', () => {
  it('is dead with the master off, whatever the engine does (magnetos are independent)', () => {
    const e = new ElectricalSystem();
    const s = run(e, 10, { battery: false, alternator: false, avionics: true }, loads(), 2400);
    expect(s.busVolts).toBe(0);
    expect(s.mainPowered).toBe(false);
    expect(s.avionicsPowered).toBe(false);
    expect(e.charge).toBe(1);
  });

  it('battery only: about 25 V, discharging by the load, LOW VOLTS lit', () => {
    const e = new ElectricalSystem();
    const s = run(e, 5, { battery: true, alternator: false, avionics: true }, loads(), 0);
    expect(s.busVolts).toBeGreaterThan(24.5 - 1);
    expect(s.busVolts).toBeLessThan(25.6);
    expect(s.batteryAmps).toBeLessThan(-10); // base + nav + beacon + avionics ≈ 15.5 A
    expect(s.lowVoltage).toBe(true);
    expect(s.avionicsPowered).toBe(true);
  });

  it('engine running with BAT+ALT: regulated 28.5 V, alternator carries the load and recharges the battery', () => {
    const e = new ElectricalSystem(undefined, 0.6);
    const s = run(e, 60, ON, loads({ landing: true, pitotHeat: true }), 2300);
    expect(s.busVolts).toBeCloseTo(C172S_ELECTRICAL.regulatorV, 3);
    expect(s.lowVoltage).toBe(false);
    expect(s.batteryAmps).toBeGreaterThan(0);
    expect(s.alternatorAmps).toBeCloseTo(s.loadAmps + s.batteryAmps, 6);
    expect(e.charge).toBeGreaterThan(0.6);
  });

  it('alternator off in flight: the battery lasts about half an hour (POH: ~30 min with load shedding)', () => {
    const e = new ElectricalSystem();
    const sw = { battery: true, alternator: false, avionics: true };
    let t = 0;
    while (e.state.busVolts === 0 || e.state.mainPowered) {
      e.step(1, sw, loads(), 2300);
      t += 1;
      if (t > 3 * 3600) break;
    }
    // ~15.5 A on a 12.75 Ah battery (a little better once the avionics drop out)
    expect(t / 60).toBeGreaterThan(35);
    expect(t / 60).toBeLessThan(60);
  });

  it('cranks with a good battery, barely with a weak one, not at all when flat', () => {
    const good = new ElectricalSystem(undefined, 1);
    good.step(0.1, { battery: true, alternator: true, avionics: false }, loads({ starter: true }), 0);
    expect(good.state.busVolts).toBeGreaterThan(19);
    expect(good.starterFactor()).toBeGreaterThan(0.5);
    const weak = new ElectricalSystem(undefined, 0.35);
    weak.step(0.1, { battery: true, alternator: true, avionics: false }, loads({ starter: true }), 0);
    expect(weak.starterFactor()).toBeLessThan(good.starterFactor());
    expect(weak.starterFactor()).toBeGreaterThan(0);
    const flat = new ElectricalSystem(undefined, 0.05);
    flat.step(0.1, { battery: true, alternator: true, avionics: false }, loads({ starter: true }), 0);
    expect(flat.starterFactor()).toBe(0);
  });

  it('the alternator needs the battery to excite its field, then keeps itself excited', () => {
    const e = new ElectricalSystem();
    // ALT on, BAT off from the start: no field, no power
    run(e, 2, { battery: false, alternator: true, avionics: false }, loads(), 2300);
    expect(e.state.busVolts).toBe(0);
    // BAT on excites it; then BAT off: the alternator alone still powers the bus
    run(e, 2, { battery: true, alternator: true, avionics: false }, loads(), 2300);
    const s = run(e, 2, { battery: false, alternator: true, avionics: false }, loads(), 2300);
    expect(s.busVolts).toBeCloseTo(28.5, 3);
    expect(s.batteryAmps).toBe(0);
  });

  it('at idle the alternator output drops and the battery helps carry a heavy load', () => {
    const e = new ElectricalSystem();
    const s = run(e, 5, ON, loads({ landing: true, taxi: true, pitotHeat: true, strobe: true }), 650);
    expect(s.alternatorAmps).toBeLessThan(10);
    expect(s.batteryAmps).toBeLessThan(0);
    expect(s.busVolts).toBeLessThan(28.5);
  });
});
