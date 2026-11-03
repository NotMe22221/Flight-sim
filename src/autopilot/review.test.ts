/**
 * Adversarial-review regression tests: each case reproduces a defect found in review (it failed
 * before the fix) or pins a convention against the real producers (src/nav, src/fdm).
 */
import { describe, expect, it } from 'vitest';
import { defaultControlInputs } from '../core/types';
import { deltaDeg } from '../core/math';
import { DEG, FPM, FT, KT, NM } from '../core/units';
import { airborne, makeEnv, makeFdm } from '../fdm/testing';
import { GfcAutopilot } from './Autopilot';
import { FlightAssists } from './assists';
import { headingToBank } from './lateral';
import { FDM_DT, ZohSim } from './reviewHarness';
import { makeNavRadioState } from './testPlant';
import { type TestIls } from './testPlant';
import { Sim } from './testSim';

const altFt = (sim: Sim) => sim.ac.altitudeMslM / FT;

describe('review: vertical mode logic', () => {
  it('with GS armed, a VS descent below the glideslope still levels at the selected altitude (ALTS stays armed)', () => {
    // ILS to the north; the aircraft is established on the localizer 9 nm out, about one dot BELOW
    // the glideslope, and descends at 500 fpm toward a selected 1500 ft. GS cannot capture from
    // below while descending in parallel, so only the altitude pre-select stops the descent.
    const ils: TestIls = { locNorthM: 2000, locEastM: 0, gsNorthM: 300, gsEastM: 0, gsElevationM: 0, courseRad: 0, glideRad: 3 * DEG };
    const dist = 9 * NM;
    const sim = new Sim({ speedMs: 90 * KT, altitudeM: 2500 * FT, headingRad: 0, northM: ils.gsNorthM - dist });
    sim.ils = ils;
    sim.pilot.throttle = 0.35;
    sim.frame();
    expect(sim.nav1.gsDeviation).toBeGreaterThan(0.25); // below the path (fly up)
    sim.ap.setAltitudeTarget(1500 * FT);
    sim.ap.engage(true);
    sim.ap.setLateral('APR');
    expect(sim.s.lateral).toBe('APR');
    expect(sim.s.armedVertical).toBe('GS');
    sim.ap.setVerticalSpeedTarget(-500 * FPM);
    sim.ap.setVertical('VS');
    let minAltBeforeGs = Infinity, gsT = -1, altT = -1;
    sim.run(240, (s) => {
      if (gsT < 0 && s.s.vertical === 'GS') gsT = s.t;
      if (altT < 0 && s.s.vertical === 'ALT') altT = s.t;
      if (gsT < 0) minAltBeforeGs = Math.min(minAltBeforeGs, altFt(s));
      if (s.nav1.dmeNm < 2) return true;
    });
    expect(altT).toBeGreaterThan(0); // the selected altitude was captured ...
    expect(minAltBeforeGs).toBeGreaterThan(1500 - 40); // ... without descending through it
    expect(gsT).toBeGreaterThan(altT); // and the glideslope (still armed) captured afterwards
  });
});

describe('review: altitude alerter (KAP 140 bands: 1000 → 200 ft before, ±200 ft after reaching)', () => {
  it('a 1500 fpm climb and capture shows approach, never deviation; deviation only after the altitude was held', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.pilot.throttle = 1;
    sim.ap.setAltitudeTarget(5000 * FT);
    sim.ap.engage(true);
    sim.ap.setVerticalSpeedTarget(1500 * FPM);
    sim.ap.setVertical('VS');
    const seen = new Set<string>();
    let deviationDuringCapture = false, approachBand = true;
    sim.run(300, (s) => {
      const a = s.s.altAlert, err = 5000 - altFt(s);
      seen.add(a);
      if (a === 'deviation') deviationDuringCapture = true;
      if (a === 'approach' && (err > 1001 || err < 199)) approachBand = false; // 1 ft: the alert is computed before the step
    });
    expect(sim.s.vertical).toBe('ALT');
    expect(seen.has('approach')).toBe(true);
    expect(approachBand).toBe(true);
    expect(deviationDuringCapture).toBe(false);
    expect(sim.s.altAlert).toBe('none');
    // held: a 300 ft excursion is a deviation
    const low = { ...sim.ac, altitudeIndicatedM: sim.ac.altitudeIndicatedM - 300 * FT };
    sim.ap.update(1 / 120, low, { nav1: sim.nav1, nav2: sim.nav2, plan: null });
    expect(sim.s.altAlert).toBe('deviation');
    // a newly selected altitude is approached again, not a deviation from the old one
    sim.ap.setAltitudeTarget(3000 * FT);
    sim.ap.update(1 / 120, sim.ac, { nav1: sim.nav1, nav2: sim.nav2, plan: null });
    expect(sim.s.altAlert).not.toBe('deviation');
  });
});

describe('review: engagement', () => {
  it('engaging before the first apply() keeps the pilot trim and stick (no trim bump)', () => {
    // pilot flies with nose-up trim held by forward stick: δe = −0.1 + 0.4·0.25 = 0 (plant trimmed)
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.pilot.pitchTrim = 0.25;
    sim.pilot.pitch = -0.1;
    sim.ap.engage(true); // e.g. straight after construction / reset(), before any frame ran
    sim.frame();
    expect(sim.last.pitchTrim).toBeCloseTo(0.25, 9);
    expect(sim.pilot.pitchTrim).toBeCloseTo(0.25, 9); // the trim written back to the pilot is unchanged
    expect(Math.abs(sim.last.pitch - -0.1)).toBeLessThan(0.02);
    // same flight as engaging one frame later (the normal path, controls already sampled)
    const ref = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    ref.pilot.pitchTrim = 0.25;
    ref.pilot.pitch = -0.1;
    ref.frame();
    ref.ap.engage(true);
    sim.run(20);
    ref.run(20 - 1 / 120);
    expect(Math.abs(altFt(sim) - altFt(ref))).toBeLessThan(1);
    expect(sim.s.trimCommand).toBeCloseTo(ref.s.trimCommand, 3);
  });
});

describe('review: lateral mode logic', () => {
  it('pressing NAV / APR while only armed disarms it and leaves the active HDG turn alone', () => {
    for (const key of ['NAV', 'APR'] as const) {
      const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0, eastM: 8 * NM });
      sim.course = { startNorthM: -5 * NM, startEastM: 0, endNorthM: 60 * NM, endEastM: 0 }; // 8 nm away: stays armed
      sim.usePlan = true;
      Object.assign(sim.nav1, { valid: true, isLocalizer: true, cdi: 1, obsDeg: 0, dmeNm: 15 }); // pegged localizer for APR
      sim.frame();
      sim.ap.engage(true);
      sim.ap.setHeadingBug(90);
      sim.ap.setLateral('HDG');
      sim.ap.press(key);
      expect(sim.s.armedLateral).toBe(key);
      sim.run(8); // well into the right turn
      expect(sim.ac.euler[0]).toBeGreaterThan(10 * DEG);
      sim.ap.press(key);
      expect(sim.s.armedLateral).toBeNull();
      expect(sim.s.lateral).toBe('HDG');
      sim.run(60);
      expect(Math.abs(deltaDeg(sim.ac.headingMagRad / DEG, 90))).toBeLessThan(2); // rolled out on the bug, not circling
      expect(Math.abs(sim.ac.euler[0])).toBeLessThan(2 * DEG);
    }
  });

  it('heading error wraps the short way across north, for [0, 2π) and (−π, π] headings', () => {
    for (const cur of [359 * DEG, -1 * DEG]) expect(headingToBank(1 * DEG, cur, 1, 25 * DEG)).toBeCloseTo(2 * DEG, 12); // right
    for (const cur of [1 * DEG, 361 * DEG]) expect(headingToBank(359 * DEG, cur, 1, 25 * DEG)).toBeCloseTo(-2 * DEG, 12); // left
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 350 * DEG });
    sim.ap.engage(true);
    sim.ap.setHeadingBug(10);
    sim.ap.setLateral('HDG');
    let minRoll = 0;
    sim.run(40, (s) => { minRoll = Math.min(minRoll, s.ac.euler[0]); });
    expect(minRoll).toBeGreaterThan(-0.5 * DEG); // never rolled left (the long way round)
    expect(Math.abs(deltaDeg(sim.ac.headingMagRad / DEG, 10))).toBeLessThan(1);
  });

  it('NAV selected from ROL before the first update still auto-intercepts (no armed-forever while flying parallel)', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0, eastM: 2 * NM });
    sim.course = { startNorthM: -5 * NM, startEastM: 0, endNorthM: 60 * NM, endEastM: 0 };
    sim.usePlan = true;
    sim.ap.engage(true); // no frame has run yet: the AP has seen no nav data
    sim.ap.setLateral('NAV');
    sim.frame();
    expect(sim.s.lateral).toBe('NAV');
    sim.run(200);
    expect(Math.abs(sim.plan.crossTrackM)).toBeLessThan(0.1 * NM);
  });

  it('...but only on that first update: with HDG flying, or a dead receiver at selection, NAV stays armed', () => {
    const hdg = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0, eastM: 2 * NM });
    hdg.course = { startNorthM: -5 * NM, startEastM: 0, endNorthM: 60 * NM, endEastM: 0 };
    hdg.usePlan = true;
    hdg.ap.engage(true);
    hdg.ap.setHeadingBug(0);
    hdg.ap.setLateral('HDG');
    hdg.ap.setLateral('NAV');
    hdg.run(5);
    expect(hdg.s.lateral).toBe('HDG');
    expect(hdg.s.armedLateral).toBe('NAV');
    const dead = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    dead.ap.engage(true);
    dead.ap.setLateral('NAV'); // NAV1 flagged, no plan
    dead.run(1);
    Object.assign(dead.nav1, { valid: true, isLocalizer: false, cdi: 0.9, obsDeg: 90, dmeNm: 20 }); // station comes alive far off course
    dead.run(1);
    expect(dead.s.lateral).toBe('ROL');
    expect(dead.s.armedLateral).toBe('NAV');
  });
});

describe('review: apply() returns complete controls', () => {
  it('carries every pilot field, including the optional master / avionics / fuel-pump switches', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    const p = sim.pilot;
    Object.assign(p, {
      rudderTrim: 0.1, aileronTrim: -0.1, flapsIndex: 2, throttle: 0.7, mixture: 0.8, propeller: 0.9, brakeLeft: 0.2, brakeRight: 0.3,
      parkingBrake: true, magnetos: 2, starter: true, fuelSelector: 'left', gearDown: false, speedbrake: 0.4, pitotHeat: true, carbHeat: true,
      masterBattery: false, masterAlternator: false, avionicsMaster: false, fuelPump: true,
    });
    Object.assign(p.lights, { nav: true, beacon: true, strobe: true, landing: true, taxi: true, panel: 0.5 });
    sim.ap.setYawDamper(true); // AP off, YD on: apply() returns its private copy
    for (const engaged of [false, true]) {
      if (engaged) sim.ap.engage(true);
      const o = sim.ap.apply(p) as unknown as Record<string, unknown>;
      expect(o).not.toBe(p);
      for (const [k, v] of Object.entries(p)) {
        if (k === 'pitch' || k === 'roll' || k === 'yaw' || k === 'pitchTrim') continue; // the AP's outputs
        expect(o[k], k).toEqual(v);
      }
    }
  });
});

describe('review: NaN never reaches (or latches in) the servos', () => {
  const finiteOut = (sim: Sim) =>
    [sim.s.outRoll, sim.s.outPitch, sim.s.outYaw, sim.s.trimCommand, sim.last.roll, sim.last.pitch, sim.last.yaw, sim.last.pitchTrim].every(Number.isFinite);

  it('non-finite targets from a setter or a written state field are ignored', () => {
    const pokes: ((s: Sim) => void)[] = [
      (s) => { s.ap.setHeadingBug(NaN); s.ap.setLateral('HDG'); },
      (s) => { s.ap.setAltitudeTarget(NaN); s.ap.setVertical('ALT'); },
      (s) => { s.ap.setVerticalSpeedTarget(NaN); s.ap.setVertical('VS'); },
      (s) => { s.ap.setIasTarget(Number.POSITIVE_INFINITY); s.ap.setVertical('FLC'); },
      (s) => { s.ap.setPitchTarget(NaN); s.s.pitchTargetRad = NaN; },
      (s) => { s.ap.setLateral('HDG'); s.s.headingBugDeg = NaN; },
    ];
    for (const poke of pokes) {
      const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
      sim.ap.setYawDamper(true);
      sim.ap.engage(true);
      sim.run(1);
      poke(sim);
      sim.run(2);
      expect(finiteOut(sim)).toBe(true);
      expect(Number.isFinite(sim.ac.euler[0]) && Number.isFinite(sim.ac.euler[1])).toBe(true);
    }
  });

  it('a frame of NaN nav deviation or air data does not poison the loops', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    const r = sim.nav1;
    r.valid = true; r.isLocalizer = true; r.cdi = 0.1; r.obsDeg = 0; r.dmeNm = 5; r.gsValid = true; r.gsDeviation = 0.2;
    sim.ap.setYawDamper(true);
    sim.ap.engage(true);
    sim.ap.setLateral('APR');
    sim.run(2);
    expect(sim.s.lateral).toBe('APR');
    expect(sim.s.vertical).toBe('GS');
    r.cdi = NaN; r.gsDeviation = NaN;
    sim.frame();
    r.cdi = 0.1; r.gsDeviation = 0.2;
    // one frame of garbage air data from the flight model
    sim.ap.update(1 / 120, { ...sim.ac, euler: [NaN, NaN, NaN], rates: [NaN, NaN, NaN], verticalSpeedMs: NaN, aero: { ...sim.ac.aero, ias: NaN, tas: NaN } }, { nav1: r, nav2: sim.nav2, plan: null });
    sim.run(2);
    expect(finiteOut(sim)).toBe(true);
    expect(Number.isFinite(sim.ap.rollCommandRad) && Number.isFinite(sim.ap.pitchCommandRad)).toBe(true);
    expect(sim.s.engaged).toBe(true);
  });
});

describe('review: assists never pass NaN to the flight model', () => {
  it('a frame of NaN air data neither reaches the controls nor latches the assist integrators', () => {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    const a = new FlightAssists({ antiStall: { stallAlphaRad: 0.28 } });
    const flags = { autoRudder: true, assistedTakeoff: true, antiStall: true };
    sim.beforeStep = (s, u, dt) => { a.apply(u, s.ac, dt, flags); };
    sim.pilot.roll = 0.1;
    sim.pilot.pitch = 0.2;
    sim.run(2);
    const bad = { ...sim.ac, rates: [NaN, NaN, NaN] as [number, number, number], aero: { ...sim.ac.aero, beta: NaN, alpha: NaN, alphaDot: NaN, ias: NaN } };
    const u = { ...sim.pilot };
    a.apply(u, bad, 1 / 120, flags);
    expect(Number.isFinite(u.yaw) && Number.isFinite(u.pitch)).toBe(true);
    sim.run(2);
    expect(Number.isFinite(sim.last.yaw) && Number.isFinite(sim.last.pitch)).toBe(true);
    expect(Number.isFinite(a.rudderAssist)).toBe(true);
    // ground roll: garbage heading for a frame during the hold
    const g = new FlightAssists();
    const ac = { ...sim.ac, onGround: true, groundSpeedMs: 5, headingTrueRad: 1, posNED: [0, 0, 0] as [number, number, number] };
    const v = { ...sim.pilot, throttle: 1, parkingBrake: false };
    g.apply(v, ac, 1 / 120, flags);
    expect(g.takeoffHeadingRad).toBeCloseTo(1, 9);
    g.apply(v, { ...ac, headingTrueRad: NaN }, 1 / 120, flags);
    v.yaw = 0;
    g.apply(v, ac, 1 / 120, flags);
    expect(Number.isFinite(v.yaw)).toBe(true);
    expect(g.takeoffHeadingRad).toBeCloseTo(1, 9);
  });
});

describe('review: protections on the real C172S flight model', () => {
  it('stays engaged in moderate turbulence at approach speed when the pilot manages power (75 KCAS flaps 10, 3 min)', () => {
    // Evidence for keeping the immediate stall-warning disconnect: with the energy managed, gusts
    // never trip the warning at normal speeds; it only chirps once the speed has really decayed.
    const sim = new ZohSim(1500 * FT, 75, 0, 2, makeEnv({ turbulence: { w20Kt: 0, intensity: 4, seed: 1 } }));
    sim.pilot.flapsIndex = 1;
    const thr0 = sim.pilot.throttle;
    sim.pilotHook = (s) => { s.pilot.throttle = Math.min(1, Math.max(0, thr0 + 0.1 + 0.08 * (75 - s.ac.aero.ias / KT))); };
    sim.run(2);
    const alt0 = sim.ac.altitudeIndicatedM;
    sim.ap.setAltitudeTarget(alt0);
    sim.ap.engage(true);
    sim.ap.setVertical('ALT');
    sim.ap.setHeadingBug(Math.round(sim.ac.headingMagRad / DEG));
    sim.ap.setLateral('HDG');
    let maxAltErr = 0, maxBank = 0;
    sim.run(180, (s) => {
      maxAltErr = Math.max(maxAltErr, Math.abs(s.ac.altitudeIndicatedM - alt0));
      maxBank = Math.max(maxBank, Math.abs(s.ac.euler[0]));
    });
    expect(sim.s.engaged).toBe(true);
    expect(sim.s.disconnectReason).toBeNull();
    expect(maxAltErr).toBeLessThan(100 * FT);
    expect(maxBank).toBeLessThan(30 * DEG);
  });

  it('disconnects on the stall warning before the stall when ALT hold at low power bleeds the speed off', () => {
    const sim = new ZohSim(2000 * FT, 75, 0, 2);
    sim.pilot.throttle -= 0.05;
    sim.ap.setAltitudeTarget(2000 * FT);
    sim.ap.engage(true);
    sim.ap.setVertical('ALT');
    let warnT = -1;
    sim.run(150, (s) => { if (warnT < 0 && s.ac.aero.stallWarning) warnT = s.t; return !s.s.engaged; });
    expect(warnT).toBeGreaterThan(0);
    expect(sim.s.engaged).toBe(false);
    expect(sim.s.disconnectReason).toBe('stall');
    expect(sim.t - warnT).toBeLessThan(0.1);
    expect(sim.ac.aero.stalled).toBe(false);
  });
});

describe('review: checks the test plant cannot make', () => {
  it('yaw damper damps the C172 dutch roll (the test plant has no yaw dynamics, so a flipped sign passed there)', () => {
    const doublet = (ydGain: number | null) => {
      const env = makeEnv();
      const f = makeFdm(1043);
      const pilot = airborne(f, env, 3000 * FT, 100);
      const ap = new GfcAutopilot(ydGain === null ? {} : { config: { gains: { ydGain } } });
      const nav = { nav1: makeNavRadioState(), nav2: makeNavRadioState(), plan: null };
      if (ydGain !== null) ap.setYawDamper(true);
      const u = defaultControlInputs();
      let sum = 0, n = 0;
      for (let t = 0; t < 14; t += 2 * FDM_DT) {
        Object.assign(u, pilot);
        u.lights = pilot.lights;
        u.yaw = t > 1 && t < 1.5 ? 0.4 : t >= 1.5 && t < 2 ? -0.4 : 0;
        ap.update(2 * FDM_DT, f.state, nav);
        const o = ap.apply(u);
        f.step(FDM_DT, o, env);
        f.step(FDM_DT, o, env);
        if (t > 2.5) { sum += f.state.rates[2] ** 2; n++; }
      }
      return Math.sqrt(sum / n); // yaw-rate RMS after the pedal doublet
    };
    const off = doublet(null), on = doublet(0.8), flipped = doublet(-0.8);
    expect(on).toBeLessThan(0.5 * off);
    expect(flipped).toBeGreaterThan(2 * off);
  });

  it('flies the same at 30 Hz as at 120 Hz with the simulator wiring (AP per frame, FDM sub-stepped at 120 Hz)', () => {
    const hdg = (sub: number) => {
      const sim = new ZohSim(3000 * FT, 100, 0, sub);
      sim.ap.engage(true);
      sim.ap.setHeadingBug(90);
      sim.ap.setLateral('HDG');
      const out: number[] = [];
      let next = 10;
      sim.run(60, (s) => { if (s.t >= next - 1e-9) { out.push(s.ac.headingMagRad / DEG); next += 10; } });
      return out;
    };
    const alt = (sub: number) => {
      const sim = new ZohSim(3000 * FT, 100, 0, sub);
      sim.pilot.throttle = 1;
      sim.ap.engage(true);
      sim.ap.setAltitudeTarget(3500 * FT);
      sim.ap.setVertical('ALT');
      const out: number[] = [];
      let next = 10;
      sim.run(90, (s) => { if (s.t >= next - 1e-9) { out.push(s.ac.altitudeIndicatedM / FT); next += 10; } });
      return out;
    };
    const h1 = hdg(1), h4 = hdg(4), a1 = alt(1), a4 = alt(4);
    expect(h4.length).toBe(h1.length);
    for (let i = 0; i < h1.length; i++) expect(Math.abs(deltaDeg(h4[i], h1[i]))).toBeLessThan(1);
    for (let i = 0; i < a1.length; i++) expect(Math.abs(a4[i] - a1[i])).toBeLessThan(10);
  });
});
