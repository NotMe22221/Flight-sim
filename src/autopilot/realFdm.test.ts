/**
 * Integration checks on the real C172S flight model (src/fdm), wired the way README.md tells the
 * simulator to wire it: pilot controls → copy → autopilot.update/apply → assists → fdm.step.
 * The formal acceptance numbers are asserted on the test plant (Autopilot.test.ts); these runs
 * make sure the same gains fly the aircraft the simulator actually uses.
 */
import { describe, expect, it } from 'vitest';
import { defaultControlInputs, type ControlInputs, type Environment } from '../core/types';
import { deltaDeg, wrapPi } from '../core/math';
import { DEG, FPM, FT, KT, NM } from '../core/units';
import { C172S, type Fdm } from '../fdm';
import { KSFO, airborne, makeEnv, makeFdm } from '../fdm/testing';
import { GfcAutopilot } from './Autopilot';
import { FlightAssists, stallAlphaFromConfig, type AssistFlags } from './assists';
import { makeFlightPlan, makeNavRadioState, updateTestIls, updateTestPlan, type TestCourse, type TestIls } from './testPlant';

const DT = 1 / 120;

class RealSim {
  readonly env: Environment;
  readonly fdm: Fdm;
  readonly ap = new GfcAutopilot();
  readonly assists = new FlightAssists({ antiStall: { stallAlphaRad: stallAlphaFromConfig(C172S) } });
  flags: AssistFlags | null = null;
  readonly pilot: ControlInputs;
  readonly eff: ControlInputs = defaultControlInputs();
  readonly nav1 = makeNavRadioState();
  readonly nav2 = makeNavRadioState();
  readonly plan = makeFlightPlan();
  course: TestCourse | null = null;
  ils: TestIls | null = null;
  t = 0;

  constructor(altM: number, kcas: number, hdgDeg = 0, env: Environment = makeEnv()) {
    this.env = env;
    this.fdm = makeFdm(1043);
    this.pilot = airborne(this.fdm, env, altM, kcas, hdgDeg);
  }

  get ac() { return this.fdm.state; }
  get s() { return this.ap.state; }

  frame(): void {
    if (this.course) updateTestPlan(this.ac, this.course, this.plan);
    if (this.ils) {
      updateTestIls(this.ac, this.ils, this.nav1);
      // the test ILS gives a true course; receivers report the OBS magnetic
      const magvarDeg = wrapPi(this.ac.headingTrueRad - this.ac.headingMagRad) / DEG;
      this.nav1.obsDeg = (((this.nav1.obsDeg - magvarDeg) % 360) + 360) % 360;
    }
    Object.assign(this.eff, this.pilot);
    this.eff.lights = this.pilot.lights;
    this.ap.update(DT, this.ac, { nav1: this.nav1, nav2: this.nav2, plan: this.course ? this.plan : null });
    const o = this.ap.apply(this.eff);
    if (o !== this.eff) Object.assign(this.eff, o);
    if (this.s.engaged) this.pilot.pitchTrim = this.s.trimCommand;
    if (this.flags) this.assists.apply(this.eff, this.ac, DT, this.flags);
    this.fdm.step(DT, this.eff, this.env);
    this.t += DT;
  }

  run(seconds: number, probe?: (s: RealSim) => boolean | void): void {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      this.frame();
      if (probe && probe(this) === true) return;
    }
  }
}

const altFt = (s: RealSim) => s.ac.altitudeIndicatedM / FT;

describe('autopilot on the C172S flight model', () => {
  it('HDG 000 → 090 at 100 KCAS: captured within 60 s, no overshoot, standard-rate bank', () => {
    const sim = new RealSim(3000 * FT, 100);
    sim.ap.engage(true);
    sim.ap.setHeadingBug(90);
    sim.ap.setLateral('HDG');
    let maxBank = 0, maxOver = 0, captureT = -1;
    sim.run(60, (s) => {
      maxBank = Math.max(maxBank, Math.abs(s.ac.euler[0]));
      const err = deltaDeg(s.ac.headingMagRad / DEG, 90);
      maxOver = Math.max(maxOver, err);
      if (captureT < 0 && Math.abs(err) < 2) captureT = s.t;
      else if (captureT >= 0 && Math.abs(err) >= 2) captureT = -1;
    });
    expect(captureT).toBeGreaterThan(0);
    expect(maxOver).toBeLessThan(3);
    expect(maxBank).toBeLessThanOrEqual(25.5 * DEG);
    expect(sim.s.engaged).toBe(true);
  });

  it('ALT 3000 → 3500 ft at full power: VS ≤ 800 fpm, overshoot < 40 ft, error < 10 ft', () => {
    const sim = new RealSim(3000 * FT, 100);
    sim.pilot.throttle = 1;
    sim.ap.engage(true);
    sim.ap.setAltitudeTarget(3500 * FT);
    sim.ap.setVertical('ALT');
    let maxVs = 0, maxAlt = 0;
    sim.run(120, (s) => { maxVs = Math.max(maxVs, s.ac.verticalSpeedMs / FPM); maxAlt = Math.max(maxAlt, altFt(s)); });
    expect(maxVs).toBeLessThanOrEqual(800);
    expect(maxAlt - 3500).toBeLessThan(40);
    expect(Math.abs(altFt(sim) - 3500)).toBeLessThan(10);
  });

  it('VS +500 fpm within ±50 fpm, and FLC 90 kt within ±3 kt while climbing', () => {
    const vs = new RealSim(5000 * FT, 100);
    vs.pilot.throttle = 1;
    vs.ap.setAltitudeTarget(15000 * FT);
    vs.ap.engage(true);
    vs.ap.setVerticalSpeedTarget(500 * FPM);
    vs.ap.setVertical('VS');
    let vsErr = 0;
    vs.run(75, (s) => { if (s.t > 30) vsErr = Math.max(vsErr, Math.abs(s.ac.verticalSpeedMs / FPM - 500)); });
    expect(vsErr).toBeLessThan(50);
    const flc = new RealSim(3000 * FT, 90);
    flc.ap.setAltitudeTarget(12000 * FT);
    flc.ap.engage(true);
    flc.ap.setIasTarget(90 * KT);
    flc.ap.setVertical('FLC');
    flc.pilot.throttle = 1;
    let iasErr = 0, minVs = Infinity;
    flc.run(90, (s) => { if (s.t > 20) { iasErr = Math.max(iasErr, Math.abs(s.ac.aero.ias / KT - 90)); minVs = Math.min(minVs, s.ac.verticalSpeedMs / FPM); } });
    expect(iasErr).toBeLessThan(3);
    expect(minVs).toBeGreaterThan(300);
  });

  it('NAV from 2 nm right of a GPS course: intercept ≤ 45°, converges within 0.1 nm', () => {
    const sim = new RealSim(3000 * FT, 100);
    const n0 = sim.ac.posNED[0], e0 = sim.ac.posNED[1];
    sim.course = { startNorthM: n0 - 5 * NM, startEastM: e0 - 2 * NM, endNorthM: n0 + 60 * NM, endEastM: e0 - 2 * NM };
    sim.frame();
    sim.ap.engage(true);
    sim.ap.setLateral('NAV');
    let maxIntercept = 0, convergedT = -1;
    sim.run(160, (s) => {
      if (s.t > 15) maxIntercept = Math.max(maxIntercept, Math.abs(deltaDeg(s.ac.trackRad / DEG, 0)));
      if (convergedT < 0 && Math.abs(s.plan.crossTrackM) < 0.1 * NM) convergedT = s.t;
    });
    expect(convergedT).toBeGreaterThan(0);
    expect(maxIntercept).toBeLessThanOrEqual(45);
    expect(Math.abs(sim.plan.crossTrackM)).toBeLessThan(0.1 * NM);
  });

  it('APR: from one dot below the glideslope at 6 nm captures and tracks within 0.2 dots', () => {
    const dist = 6 * NM;
    const sim = new RealSim(dist * Math.tan(3 * DEG - 0.35 * DEG), 90);
    const n0 = sim.ac.posNED[0], e0 = sim.ac.posNED[1];
    sim.ils = { locNorthM: n0 + dist + 1700, locEastM: e0, gsNorthM: n0 + dist, gsEastM: e0, gsElevationM: 0, courseRad: 0, glideRad: 3 * DEG };
    sim.frame();
    expect(sim.nav1.gsDeviation * 2).toBeCloseTo(1, 2);
    sim.ap.setAltitudeTarget(sim.ac.altitudeIndicatedM);
    sim.ap.engage(true);
    sim.ap.setVertical('ALT');
    sim.ap.setLateral('APR');
    let captureT = -1, maxDev = 0, maxCdi = 0;
    sim.run(200, (s) => {
      if (captureT < 0 && s.s.vertical === 'GS') captureT = s.t;
      if (captureT > 0 && s.t > captureT + 40 && s.nav1.dmeNm > 1) {
        maxDev = Math.max(maxDev, Math.abs(s.nav1.gsDeviation * 2));
        maxCdi = Math.max(maxCdi, Math.abs(s.nav1.cdi));
      }
      if (s.nav1.dmeNm < 1) return true;
    });
    expect(captureT).toBeGreaterThan(0);
    expect(maxDev).toBeLessThan(0.2);
    expect(maxCdi).toBeLessThan(0.1);
  });

  it('engages bumplessly with the pilot holding a stick input', () => {
    const sim = new RealSim(3000 * FT, 100);
    sim.run(1);
    sim.pilot.pitch -= 0.1;
    sim.run(2);
    const before = sim.eff.pitch;
    sim.ap.engage(true);
    sim.frame();
    expect(Math.abs(sim.eff.pitch - before)).toBeLessThan(0.05);
    let maxJump = 0, prev = sim.eff.pitch;
    sim.run(5, (s) => { maxJump = Math.max(maxJump, Math.abs(s.eff.pitch - prev)); prev = s.eff.pitch; });
    expect(maxJump).toBeLessThan(0.05);
  });

  it('LVL recovers a 140° rolling dive without pulling while inverted or beyond 2 g', () => {
    const sim = new RealSim(6000 * FT, 120);
    const p0 = sim.pilot.pitch;
    sim.pilot.roll = 0.6;
    sim.pilot.pitch = p0 - 0.15;
    sim.run(2.5);
    sim.pilot.roll = 0;
    sim.pilot.pitch = p0;
    expect(Math.abs(sim.ac.euler[0])).toBeGreaterThan(120 * DEG);
    sim.ap.level();
    let nzInverted = -Infinity, maxNz = 0;
    sim.run(40, (s) => {
      if (Math.abs(s.ac.euler[0]) > 90 * DEG) nzInverted = Math.max(nzInverted, s.ac.loadFactor[2]);
      maxNz = Math.max(maxNz, s.ac.loadFactor[2]);
    });
    expect(sim.s.engaged).toBe(true);
    expect(nzInverted).toBeLessThan(1.2);
    expect(maxNz).toBeLessThan(2.0);
    expect(Math.abs(sim.ac.euler[0])).toBeLessThan(1 * DEG);
    expect(Math.abs(sim.ac.verticalSpeedMs)).toBeLessThan(100 * FPM);
  });
});

describe('assists on the C172S flight model', () => {
  /** Brakes set at full power, released at 3 s; the pilot only rotates at 55 KIAS. */
  const takeoff = (assist: boolean, crosswindKt = 0) => {
    const env = makeEnv(crosswindKt ? { windNED: [0, -crosswindKt * KT, 0] } : {});
    const f = makeFdm(1043);
    const rwy = 280 * DEG;
    f.reset({ geo: { lat: KSFO.lat, lon: KSFO.lon, alt: KSFO.elev }, headingRad: rwy, speedMs: 0, onGround: true, engineRunning: true }, env);
    const pilot = defaultControlInputs();
    pilot.parkingBrake = true; pilot.throttle = 1; pilot.mixture = 1; pilot.magnetos = 3;
    const u = defaultControlInputs();
    const a = new FlightAssists();
    const n0 = f.state.posNED[0], e0 = f.state.posNED[1];
    const r = { maxHdgErr: 0, maxOffset: 0, lifted: false };
    for (let t = DT; t < 30 && !r.lifted; t += DT) {
      if (t > 3) pilot.parkingBrake = false;
      pilot.pitch = f.state.aero.ias > 55 * KT ? 0.25 : 0;
      Object.assign(u, pilot);
      u.lights = pilot.lights;
      if (assist) a.apply(u, f.state, DT, { autoRudder: true, assistedTakeoff: true });
      f.step(DT, u, env);
      const s = f.state;
      if (!s.onGround) { r.lifted = true; break; }
      r.maxHdgErr = Math.max(r.maxHdgErr, Math.abs(wrapPi(s.headingTrueRad - rwy)));
      const dN = s.posNED[0] - n0, dE = s.posNED[1] - e0;
      r.maxOffset = Math.max(r.maxOffset, Math.abs(-dN * Math.sin(rwy) + dE * Math.cos(rwy)));
    }
    return r;
  };

  it('assisted take-off keeps the take-off roll on the runway heading (calm and 10 kt crosswind)', () => {
    const off = takeoff(false);
    expect(off.maxHdgErr).toBeGreaterThan(20 * DEG); // torque / P-factor swing with the feet off the pedals
    for (const xw of [0, 10]) {
      const on = takeoff(true, xw);
      expect(on.lifted).toBe(true);
      expect(on.maxHdgErr).toBeLessThan(3 * DEG);
      expect(on.maxOffset).toBeLessThan(3);
    }
  });

  it('anti-stall: full aft stick at idle never stalls the C172', () => {
    const fly = (assist: boolean) => {
      const env = makeEnv();
      const f = makeFdm(1043);
      const pilot = airborne(f, env, 3000 * FT, 80);
      const a = new FlightAssists({ antiStall: { stallAlphaRad: stallAlphaFromConfig(C172S) } });
      const u = defaultControlInputs();
      let stalled = false, maxAlpha = 0;
      for (let t = 0; t < 25; t += DT) {
        pilot.pitch = 1;
        pilot.throttle = 0;
        Object.assign(u, pilot);
        u.lights = pilot.lights;
        if (assist) a.apply(u, f.state, DT, { autoRudder: false, assistedTakeoff: false, antiStall: true });
        f.step(DT, u, env);
        stalled ||= f.state.aero.stalled;
        maxAlpha = Math.max(maxAlpha, f.state.aero.alpha);
      }
      return { stalled, maxAlpha };
    };
    expect(fly(false).stalled).toBe(true);
    const on = fly(true);
    expect(on.stalled).toBe(false);
    expect(on.maxAlpha).toBeLessThan(stallAlphaFromConfig(C172S) - 1 * DEG);
  });

  it('auto-rudder cuts the roll-in sideslip by more than half and centres the ball afterwards', () => {
    const rollIn = (assist: boolean) => {
      const env = makeEnv();
      const f = makeFdm(1043);
      const pilot = airborne(f, env, 3000 * FT, 100);
      const a = new FlightAssists();
      const u = defaultControlInputs();
      let peak = 0;
      for (let t = 0; t < 15; t += DT) {
        pilot.roll = t > 2 && t < 4 ? 0.3 : 0;
        Object.assign(u, pilot);
        u.lights = pilot.lights;
        if (assist) a.apply(u, f.state, DT, { autoRudder: true, assistedTakeoff: false });
        f.step(DT, u, env);
        if (t > 2 && t < 10) peak = Math.max(peak, Math.abs(f.state.aero.beta));
      }
      return { peak, final: Math.abs(f.state.aero.beta) };
    };
    const off = rollIn(false), on = rollIn(true);
    expect(off.peak).toBeGreaterThan(3 * DEG);
    expect(on.peak).toBeLessThan(0.5 * off.peak);
    expect(on.final).toBeLessThan(0.2 * DEG);
  });
});
