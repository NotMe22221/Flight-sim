/**
 * Adversarial-review regression tests: each case reproduces a defect found in review (it failed
 * before the fix) or pins a convention against the real producers (src/nav, src/fdm).
 */
import { describe, expect, it } from 'vitest';
import { DEG, FPM, FT, KT, NM } from '../core/units';
import { makeEnv } from '../fdm/testing';
import { ZohSim } from './reviewHarness';
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
