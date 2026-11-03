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
