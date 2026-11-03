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
  it('rides through stall-warning chirps in moderate turbulence (75 KCAS flaps 10, ALT + HDG, 3 min)', () => {
    const fly = (persistS?: number) => {
      const sim = new ZohSim(1500 * FT, 75, 0, 2, makeEnv({ turbulence: { w20Kt: 0, intensity: 4, seed: 1 } }));
      if (persistS !== undefined) sim.ap.config.protections.warningPersistS = persistS;
      sim.pilot.flapsIndex = 1;
      const thr0 = sim.pilot.throttle;
      // the pilot manages power for 75 KIAS (the AP has no autothrottle; a mean downdraft would bleed the speed)
      sim.pilotHook = (s) => { s.pilot.throttle = Math.min(1, Math.max(0, thr0 + 0.1 + 0.08 * (75 - s.ac.aero.ias / KT))); };
      sim.run(0.05);
      sim.ap.setAltitudeTarget(sim.ac.altitudeIndicatedM);
      sim.ap.engage(true);
      sim.ap.setVertical('ALT');
      sim.ap.setHeadingBug(Math.round(sim.ac.headingMagRad / DEG));
      sim.ap.setLateral('HDG');
      const r = { sim, chirps: 0, minIas: Infinity, maxAltErr: 0 };
      let was = false;
      const alt0 = sim.ac.altitudeIndicatedM;
      sim.run(180, (s) => {
        if (s.ac.aero.stallWarning && !was) r.chirps++;
        was = s.ac.aero.stallWarning;
        if (s.s.engaged) { r.minIas = Math.min(r.minIas, s.ac.aero.ias / KT); r.maxAltErr = Math.max(r.maxAltErr, Math.abs(s.ac.altitudeIndicatedM - alt0)); }
      });
      return r;
    };
    const old = fly(0); // the previous behaviour: any warning sample disconnects
    const dbg = fly(); console.log(`old: chirps ${old.chirps} reason ${old.sim.s.disconnectReason} at ${old.sim.s.disconnectT.toFixed(1)} minIas ${old.minIas.toFixed(1)}; new: chirps ${dbg.chirps} reason ${dbg.sim.s.disconnectReason} minIas ${dbg.minIas.toFixed(1)} maxAltErr ${(dbg.maxAltErr / FT).toFixed(0)} ft`);
    expect(old.sim.s.disconnectReason).toBe('stall');
    const r = fly();
    expect(r.chirps).toBeGreaterThan(0); // the gusts do trip the stall warning ...
    expect(r.sim.s.disconnectReason).toBeNull(); // ... but a chirp is not a reason to drop the servos
    expect(r.sim.s.engaged).toBe(true);
    expect(r.minIas).toBeGreaterThan(60);
    expect(r.maxAltErr).toBeLessThan(150 * FT);
  });

  it('still disconnects on a sustained stall warning (ALT hold at low power bleeds the speed off)', () => {
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
    expect(sim.t - warnT).toBeLessThan(1.5);
    expect(sim.ac.aero.stalled).toBe(false);
  });
});
