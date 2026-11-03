/**
 * Adversarial-review regression tests: each case reproduces a defect found in review (it failed
 * before the fix) or pins a convention against the real producers (src/nav, src/fdm).
 */
import { describe, expect, it } from 'vitest';
import { DEG, FPM, FT, KT, NM } from '../core/units';
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
