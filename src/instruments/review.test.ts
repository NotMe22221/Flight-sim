/**
 * Adversarial-review regression tests: needle/scale directions, frames and time bases that the
 * first implementation got wrong. Each test failed before its fix.
 */
import { describe, expect, it } from 'vitest';
import type { ElectricalState, SimSnapshot } from '../core/types';
import { DEG } from '../core/units';
import { MagneticCompass } from './compass';
import { G1000 } from './g1000/G1000';
import { drawAttitude } from './g1000/attitude';
import { drawEis } from './g1000/eis';
import { DIGITS, drum } from './g1000/widgets';
import { WhiskeyCompassGauge } from './gauges';
import { InstrumentModel, createReadings } from './readings';
import { SteamPanel } from './SteamPanel';
import { MockCanvasFactory, mockCanvas } from './testing/mockCanvas';
import { makeSampleSnapshot } from './testing/sampleSnapshot';

const rotations = (calls: { name: string; args: unknown[] }[]): number[] => calls.filter((c) => c.name === 'rotate').map((c) => c.args[0] as number);
const textCalls = (calls: { name: string; args: unknown[] }[], t: string) => calls.filter((c) => c.name === 'fillText' && c.args[0] === t);

function elec(o: Partial<ElectricalState>): ElectricalState {
  return { busVolts: 28.4, avionicsPowered: true, mainPowered: true, batteryAmps: 1, alternatorAmps: 20, loadAmps: 19, batteryCharge: 0.9, lowVoltage: false, ...o };
}

describe('G1000 attitude', () => {
  it('flight-director bars bank toward the command: a right-bank command rotates the cue clockwise', () => {
    const s = makeSampleSnapshot({ rollDeg: 10 });
    s.autopilot.flightDirector = true;
    s.autopilot.fdRollRad = 30 * DEG;
    const m = new InstrumentModel();
    const r = m.update(s, 1 / 60);
    const mc = mockCanvas(1024, 768);
    drawAttitude(mc.ctx2d, r, s.autopilot);
    const rot = rotations(mc.ctx.calls);
    // horizon rotates by −φ (counter-clockwise for a right bank) ...
    expect(rot.some((a) => Math.abs(a + 10 * DEG) < 1e-9)).toBe(true);
    // ... while the command cue sits at +(φ_FD − φ) relative to the aircraft symbol
    expect(rot.some((a) => Math.abs(a - 20 * DEG) < 1e-9)).toBe(true);
    expect(rot.some((a) => Math.abs(a + 20 * DEG) < 1e-9)).toBe(false);
  });

  it('draws the pitch ladder to ±80° (labels at 60° when the nose is 60° up)', () => {
    const s = makeSampleSnapshot({ pitchDeg: 60 });
    const r = new InstrumentModel().update(s, 1 / 60);
    const mc = mockCanvas(1024, 768);
    drawAttitude(mc.ctx2d, r, s.autopilot);
    expect(textCalls(mc.ctx.calls, '60').length).toBe(2);
  });
});

describe('rolling digit drum', () => {
  it('continues the tape: the next higher value sits above the window centre and rolls down', () => {
    const mc = mockCanvas(200, 200);
    drum(mc.ctx2d, 100, 100, 30, 2.25, DIGITS, '20px sans-serif', '#fff');
    const y = (t: string): number => textCalls(mc.ctx.calls, t)[0].args[2] as number;
    expect(y('3')).toBeLessThan(100);
    expect(y('1')).toBeGreaterThan(100);
    // 2.25: the "2" has rolled a quarter line down from the centre, the "3" is coming in from above
    expect(y('2')).toBeCloseTo(100 + 0.25 * 30, 9);
    expect(y('3')).toBeCloseTo(100 - 0.75 * 30, 9);
  });
});

describe('magnetic compass', () => {
  function settle(longAccelG: number): number {
    const c = new MagneticCompass();
    c.reset(90);
    for (let i = 0; i < 600; i++) c.step(90, 0, 0, longAccelG, 1 / 60);
    return c.headingDeg;
  }

  it('acceleration error: accelerate → north, decelerate → south on an easterly heading (northern hemisphere)', () => {
    const steady = settle(0), accel = settle(0.2), decel = settle(-0.2);
    expect(accel).toBeLessThan(steady - 3);
    expect(decel).toBeGreaterThan(steady + 3);
  });

  it('the card reads like a real wet compass: higher headings appear left of the lubber line', () => {
    const g = new WhiskeyCompassGauge(new MockCanvasFactory());
    const r = createReadings();
    r.heading.compassDeg = 0;
    const mc = mockCanvas(400, 200);
    g.draw(mc.ctx2d, 0, 0, 200, r);
    const x = (t: string): number => textCalls(mc.ctx.calls, t)[0].args[1] as number;
    expect(x('N')).toBeCloseTo(0, 9);
    expect(x('3')).toBeLessThan(0);
    expect(x('33')).toBeGreaterThan(0);
  });
});

describe('instrument model frames and time base', () => {
  it('heading trend is the Euler heading rate (q·sinφ + r·cosφ)/cosθ, not the body yaw rate', () => {
    const s = makeSampleSnapshot({ rollDeg: 30, pitchDeg: 5 });
    const psiDot = 3 * DEG, phi = 30 * DEG, th = 5 * DEG;
    s.aircraft.rates[0] = 0;
    s.aircraft.rates[1] = psiDot * Math.sin(phi) * Math.cos(th);
    s.aircraft.rates[2] = psiDot * Math.cos(phi) * Math.cos(th);
    const r = new InstrumentModel().update(s, 1 / 60);
    expect(r.trends.headingDegPer6s).toBeCloseTo(18, 6);
  });

  it('the DG does not drift and the hour meters stop while the sim is paused', () => {
    const s = makeSampleSnapshot();
    s.assists.gyroDrift = true;
    s.paused = true;
    const m = new InstrumentModel();
    m.update(s, 0.1);
    const off0 = m.dg.offsetDeg, tach0 = m.readings.tachHours, hobbs0 = m.readings.hobbsHours;
    for (let i = 0; i < 2400; i++) m.update(s, 0.25); // 10 min of wall time
    expect(m.dg.offsetDeg).toBe(off0);
    expect(m.readings.tachHours).toBe(tach0);
    expect(m.readings.hobbsHours).toBe(hobbs0);
    s.paused = false;
    for (let i = 0; i < 2400; i++) m.update(s, 0.25);
    expect(Math.abs(m.dg.offsetDeg - off0)).toBeGreaterThan(0.5);
    expect(m.readings.tachHours).toBeGreaterThan(tach0 + 0.1);
  });
});

describe('electrical power from the FDM', () => {
  it('uses the FDM bus: avionics master off blanks the glass, LOW VOLTS and volts follow the FDM', () => {
    const s = makeSampleSnapshot();
    s.aircraft.electrical = elec({ avionicsPowered: false, busVolts: 28.3 });
    const m = new InstrumentModel();
    let r = m.update(s, 1 / 60);
    expect(r.avionicsOn).toBe(false);
    expect(r.ahrs.valid).toBe(false);
    expect(r.voltsV).toBeCloseTo(28.3, 6);
    s.aircraft.electrical = elec({ busVolts: 23.8, lowVoltage: true });
    r = m.update(s, 1 / 60);
    expect(r.avionicsOn).toBe(true);
    expect(r.annunciators.lowVolts).toBe(true);
    s.aircraft.electrical = elec({ busVolts: 0, mainPowered: false, avionicsPowered: false, batteryAmps: 0, alternatorAmps: 0, loadAmps: 0 });
    r = m.update(s, 1 / 60);
    expect(r.voltsV).toBe(0);
    expect(r.avionicsOn).toBe(false);
    expect(r.annunciators.lowVolts).toBe(false);
    expect(r.annunciators.pitotHeatOff).toBe(false); // annunciator panel unpowered
  });

  it('a dead avionics bus leaves both G1000 screens black', () => {
    const s = makeSampleSnapshot();
    s.aircraft.electrical = elec({ avionicsPowered: false });
    const g = new G1000({ createCanvas: (w, h) => new MockCanvasFactory().create(w, h) });
    expect(g.update(s, 1 / 60)).toBe(true);
    const pfd = (g.pfdCanvas as unknown as { ctx: { texts(): string[] } }).ctx;
    expect(pfd.texts().length).toBe(0);
  });

  it('honours the master / avionics switches when the flight model has no electrical system', () => {
    const s = makeSampleSnapshot();
    s.inputs.avionicsMaster = false;
    const m = new InstrumentModel();
    expect(m.update(s, 1 / 60).avionicsOn).toBe(false);
    s.inputs.avionicsMaster = true;
    expect(m.update(s, 1 / 60).avionicsOn).toBe(true);
    const cold = makeSampleSnapshot({ engineRunning: false, onGround: true });
    cold.inputs.masterBattery = false; cold.inputs.magnetos = 3;
    const m2 = new InstrumentModel();
    for (let i = 0; i < 60; i++) m2.update(cold, 1 / 30);
    expect(m2.readings.voltsV).toBeLessThan(1);
    expect(m2.readings.avionicsOn).toBe(false);
  });

  it('EIS M BATT shows the battery current, not the alternator load', () => {
    const s = makeSampleSnapshot();
    s.aircraft.electrical = elec({ batteryAmps: 3.2, alternatorAmps: 21.7 });
    const r = new InstrumentModel().update(s, 1 / 60);
    expect(r.batteryAmpsA).toBeCloseTo(3.2, 6);
    const mc = mockCanvas(1024, 768);
    drawEis(mc.ctx2d, r);
    const glyphs = mc.ctx.texts().join(''); // tabular readouts are drawn one glyph at a time
    expect(glyphs).toContain('M BATT');
    expect(glyphs).toContain('+3');
    expect(glyphs).not.toContain('+22');
  });
});

describe('SteamPanel cadence', () => {
  it('keeps ~30 Hz at 40 fps (carries the remainder instead of dropping it)', () => {
    const p = new SteamPanel({ factory: new MockCanvasFactory(), hz: 30 });
    const s: SimSnapshot = makeSampleSnapshot();
    let n = 0;
    for (let i = 0; i < 400; i++) if (p.update(s, 0.025)) n++; // 10 s
    expect(n).toBeGreaterThanOrEqual(295);
    expect(n).toBeLessThanOrEqual(301);
  });
});
