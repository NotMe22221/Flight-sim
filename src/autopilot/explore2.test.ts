import { it } from 'vitest';
import { DEG, FPM, FT, KT } from '../core/units';
import { Sim } from './testSim';

it('nan probes', () => {
  const cases: [string, (s: Sim) => void][] = [
    ['hdgBug', (s) => { s.ap.setHeadingBug(NaN); s.ap.setLateral('HDG'); }],
    ['altTarget', (s) => { s.ap.setAltitudeTarget(NaN); s.ap.setVertical('ALT'); }],
    ['vsTarget', (s) => { s.ap.setVerticalSpeedTarget(NaN); s.ap.setVertical('VS'); }],
    ['iasTarget', (s) => { s.ap.setIasTarget(NaN); s.ap.setVertical('FLC'); }],
    ['pitchTarget', (s) => { s.ap.setPitchTarget(NaN); s.ap.setVertical('PIT'); }],
  ];
  for (const [name, poke] of cases) {
    const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
    sim.ap.engage(true);
    sim.run(1);
    poke(sim);
    sim.run(1);
    const bad = `${sim.s.outRoll} ${sim.s.outPitch} ${sim.last.roll} ${sim.last.pitch}`;
    // valid values again
    sim.ap.setHeadingBug(10); sim.ap.setAltitudeTarget(3000 * FT); sim.ap.setVerticalSpeedTarget(0); sim.ap.setIasTarget(100 * KT); sim.ap.setPitchTarget(2 * DEG);
    sim.run(3);
    console.log(`${name}: during [${bad}] after [${sim.s.outRoll} ${sim.s.outPitch}] engaged ${sim.s.engaged} plantRoll ${sim.ac.euler[0]}`);
  }
  // nav: NaN CDI with a valid flag (one frame)
  const sim = new Sim({ speedMs: 100 * KT, altitudeM: 3000 * FT, headingRad: 0 });
  sim.nav1.valid = true; sim.nav1.isLocalizer = true; sim.nav1.cdi = 0.1; sim.nav1.obsDeg = 0; sim.nav1.dmeNm = 5;
  sim.ap.engage(true); sim.ap.setLateral('LOC');
  sim.run(1);
  sim.nav1.cdi = NaN; sim.frame(); sim.nav1.cdi = 0.1;
  sim.run(3);
  console.log(`cdi NaN one frame: after [${sim.s.outRoll} ${sim.s.outPitch}] mode ${sim.s.lateral}`);
  void FPM;
});
