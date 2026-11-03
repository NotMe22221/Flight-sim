import { describe, expect, it } from 'vitest';
import { defaultControlInputs, type AircraftConfig, type ControlInputs } from '../core/types';
import { wrapPi } from '../core/math';
import { DEG, FPM, FT, KT } from '../core/units';
import { FlightAssists, stallAlphaFromConfig, type AssistFlags } from './assists';
import { GroundRollPlant, type GroundRollConfig } from './testGroundRoll';
import { TestPlant, type TestPlantConfig } from './testPlant';
import { Sim } from './testSim';

const DT = 1 / 120;
const copy = (src: ControlInputs, dst: ControlInputs): ControlInputs => Object.assign(dst, src, { lights: dst.lights });

/** Take-off roll: brakes set at full power for 2 s, then released; returns the worst deviations on the ground. */
const takeoffRoll = (assist: boolean, cfg: Partial<GroundRollConfig> = {}) => {
  const rwy = 280 * DEG;
  const plant = new GroundRollPlant(rwy, cfg);
  const assists = new FlightAssists();
  const pilot = defaultControlInputs();
  const u = defaultControlInputs();
  pilot.parkingBrake = true;
  pilot.throttle = 1;
  const r = { maxHdgErr: 0, maxXtrack: 0, liftoffT: -1, heldHeading: Number.NaN, plant, assists };
  for (let t = DT; t < 40; t += DT) {
    if (t > 2) pilot.parkingBrake = false;
    copy(pilot, u);
    assists.apply(u, plant.state, DT, { autoRudder: false, assistedTakeoff: assist });
    if (t > 2.1 && t < 2.2) r.heldHeading = assists.takeoffHeadingRad;
    plant.step(DT, u);
    if (plant.state.onGround) {
      r.maxHdgErr = Math.max(r.maxHdgErr, Math.abs(wrapPi(plant.psi - rwy)));
      r.maxXtrack = Math.max(r.maxXtrack, Math.abs(plant.crossTrack(rwy)));
    } else if (r.liftoffT < 0) r.liftoffT = t;
  }
  return r;
};

/** Roll into a turn with the pilot's aileron; returns the peak and final sideslip. */
const rollIn = (flags: AssistFlags | null, plantCfg: Partial<TestPlantConfig> = {}) => {
  const plant = new TestPlant({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 }, plantCfg);
  const assists = new FlightAssists();
  const pilot = defaultControlInputs();
  const u = defaultControlInputs();
  pilot.throttle = plant.levelThrottle();
  pilot.parkingBrake = false;
  let peak = 0;
  for (let t = DT; t < 30; t += DT) {
    pilot.roll = t > 5 && t < 7 ? 0.2 : 0;
    copy(pilot, u);
    if (flags) assists.apply(u, plant.state, DT, flags);
    plant.step(DT, u);
    if (t > 5 && t < 12) peak = Math.max(peak, Math.abs(plant.state.aero.beta));
  }
  return { peak, final: plant.state.aero.beta, bank: plant.roll };
};

describe('auto-rudder: turn coordination in the air', () => {
  it('cuts the adverse-yaw sideslip of a roll-in by more than 70 %', () => {
    const off = rollIn(null);
    const on = rollIn({ autoRudder: true, assistedTakeoff: false });
    expect(off.peak).toBeGreaterThan(0.5 * DEG);
    expect(on.peak).toBeLessThan(0.3 * off.peak);
    expect(on.bank).toBeCloseTo(off.bank, 1); // the turn itself is the pilot's
  });

  it('trims out a steady sideslip (P-factor slip) with its integral', () => {
    const bias = { betaBiasRad: 2 * DEG };
    expect(Math.abs(rollIn(null, bias).final)).toBeCloseTo(2 * DEG, 3);
    expect(Math.abs(rollIn({ autoRudder: true, assistedTakeoff: false }, bias).final)).toBeLessThan(0.05 * DEG);
  });

  it('adds to the pilot pedal and does nothing when slow or with zero sideslip', () => {
    const plant = new TestPlant({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    const a = new FlightAssists();
    const u = defaultControlInputs();
    u.yaw = 0.2;
    plant.state.aero.beta = 0;
    a.autoRudder(u, plant.state, DT);
    expect(u.yaw).toBeCloseTo(0.2, 12);
    plant.state.aero.beta = 1 * DEG;
    plant.state.aero.ias = 20 * KT; // below minIas: no assist
    u.yaw = 0;
    a.autoRudder(u, plant.state, DT);
    expect(u.yaw).toBe(0);
    plant.state.aero.ias = 100 * KT;
    a.autoRudder(u, plant.state, DT);
    expect(u.yaw).toBeGreaterThan(0); // β > 0 (wind from the right) → right rudder
  });
});

describe('auto-rudder: assisted take-off holds the runway heading captured at brake release', () => {
  it('without the assist P-factor swings the nose left; with it the roll stays on the centreline', () => {
    const off = takeoffRoll(false);
    const on = takeoffRoll(true);
    expect(off.maxHdgErr).toBeGreaterThan(10 * DEG);
    expect(on.maxHdgErr).toBeLessThan(3 * DEG);
    expect(on.maxXtrack).toBeLessThan(2);
    expect(on.liftoffT).toBeGreaterThan(0);
    expect(on.heldHeading).toBeCloseTo(280 * DEG, 6); // captured at brake release
  });

  it('copes with a 10 kt crosswind (weathervaning) as well', () => {
    const on = takeoffRoll(true, { crosswindMs: 10 * KT });
    expect(on.maxHdgErr).toBeLessThan(3 * DEG);
    expect(on.maxXtrack).toBeLessThan(2);
  });

  it('releases the hold after lift-off and when the aircraft stops', () => {
    const r = takeoffRoll(true);
    expect(r.plant.state.onGround).toBe(false);
    expect(Number.isNaN(r.assists.takeoffHeadingRad)).toBe(true);
    const plant = new GroundRollPlant(0);
    const a = new FlightAssists();
    const u = defaultControlInputs();
    u.parkingBrake = true;
    a.apply(u, plant.state, DT, { autoRudder: false, assistedTakeoff: true });
    expect(Number.isNaN(a.takeoffHeadingRad)).toBe(true); // brakes set: armed, not holding
    u.parkingBrake = false;
    u.throttle = 0;
    a.apply(u, plant.state, DT, { autoRudder: false, assistedTakeoff: true });
    expect(a.takeoffHeadingRad).toBe(0); // brake release captures
    a.apply(u, plant.state, DT, { autoRudder: false, assistedTakeoff: true });
    expect(Number.isNaN(a.takeoffHeadingRad)).toBe(true); // stopped with the throttle closed: released
  });
});

describe('anti-stall pitch limiter', () => {
  const plantStallAlpha = (1.5 - 0.25) / 4.6;

  const fullAft = (assist: boolean) => {
    const plant = new TestPlant({ speedMs: 80 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    const a = new FlightAssists({ antiStall: { stallAlphaRad: plantStallAlpha } });
    const u = defaultControlInputs();
    const r = { maxAlpha: 0, stalled: false, minFactor: 1 };
    for (let t = DT; t < 30; t += DT) {
      u.pitch = 1;
      u.throttle = 0;
      if (assist) a.apply(u, plant.state, DT, { autoRudder: false, assistedTakeoff: false, antiStall: true });
      plant.step(DT, u);
      r.maxAlpha = Math.max(r.maxAlpha, plant.state.aero.alpha);
      r.stalled ||= plant.state.aero.stalled;
      r.minFactor = Math.min(r.minFactor, a.antiStallFactor);
    }
    return r;
  };

  it('full aft stick at idle stalls the plant without it and never with it', () => {
    const off = fullAft(false);
    const on = fullAft(true);
    expect(off.stalled).toBe(true);
    expect(on.stalled).toBe(false);
    expect(on.maxAlpha).toBeLessThan(plantStallAlpha - 0.5 * DEG);
    expect(on.minFactor).toBeLessThan(0.05);
  });

  it('leaves nose-down and low-α inputs alone and scales nose-up input monotonically with α', () => {
    const plant = new TestPlant({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    const a = new FlightAssists({ antiStall: { stallAlphaRad: 16 * DEG, leadS: 0 } });
    const u = defaultControlInputs();
    let prev = Infinity;
    for (const alphaDeg of [2, 10, 11.5, 12.5, 13.5, 14.5, 15.5]) { // protected α = 16 − 1.5 = 14.5°
      plant.state.aero.alpha = alphaDeg * DEG;
      u.pitch = 0.8;
      a.antiStall(u, plant.state, DT);
      expect(u.pitch).toBeLessThanOrEqual(prev);
      prev = u.pitch;
      if (alphaDeg <= 10) expect(u.pitch).toBe(0.8);
      u.pitch = -0.5;
      a.antiStall(u, plant.state, DT);
      expect(u.pitch).toBeLessThanOrEqual(-0.5);
    }
    expect(prev).toBeLessThan(0); // beyond the protected α: no nose-up left, a push instead
  });

  it('reads the stall α from an aircraft CL table', () => {
    const cfg = { aero: { CL: { table: { rows: [0, 0.1, 0.28, 0.3], cols: [0, 1], data: [0.2, 0.2, 0.9, 0.9, 1.57, 0.92, 1.5, 0.95] } } } };
    expect(stallAlphaFromConfig(cfg as unknown as AircraftConfig)).toBe(0.28);
  });
});

describe('LVL emergency', () => {
  it('rolls wings level and arrests a spiral dive through the autopilot loops, from AP off', () => {
    const sim = new Sim({ speedMs: 120 * KT, altitudeM: 5000 * FT, headingRad: 0, rollRad: 55 * DEG, gammaRad: -12 * DEG });
    const assists = new FlightAssists();
    sim.frame();
    expect(sim.s.engaged).toBe(false);
    assists.emergencyLevel(sim.ap);
    expect(sim.s.engaged).toBe(true);
    expect(sim.s.lvl).toBe(true);
    let wingsT = -1;
    sim.run(30, (s) => { if (wingsT < 0 && Math.abs(s.ac.euler[0]) < 5 * DEG) wingsT = s.t; });
    expect(wingsT).toBeGreaterThan(0);
    expect(wingsT).toBeLessThan(8);
    expect(Math.abs(sim.ac.euler[0])).toBeLessThan(1 * DEG);
    expect(Math.abs(sim.ac.verticalSpeedMs)).toBeLessThan(100 * FPM);
  });

  it('works together with auto-rudder and the anti-stall limiter in the input chain', () => {
    const sim = new Sim({ speedMs: 75 * KT, altitudeM: 5000 * FT, headingRad: 0, rollRad: -40 * DEG, gammaRad: 18 * DEG });
    const assists = new FlightAssists({ antiStall: { stallAlphaRad: (1.5 - 0.25) / 4.6 } });
    const flags: AssistFlags = { autoRudder: true, assistedTakeoff: false, antiStall: true };
    sim.beforeStep = (s, u, dt) => { assists.apply(u, s.ac, dt, flags); };
    sim.frame();
    assists.emergencyLevel(sim.ap);
    let stalled = false;
    sim.run(40, (s) => { stalled ||= s.ac.aero.stalled; });
    expect(stalled).toBe(false);
    expect(sim.s.engaged).toBe(true);
    expect(Math.abs(sim.ac.euler[0])).toBeLessThan(1 * DEG);
    expect(Math.abs(sim.ac.verticalSpeedMs)).toBeLessThan(100 * FPM);
  });
});
