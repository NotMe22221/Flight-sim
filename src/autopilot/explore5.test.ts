import { it } from 'vitest';
import { DEG, FPM, FT, KT } from '../core/units';
import { makeEnv } from '../fdm/testing';
import { ZohSim } from './reviewHarness';

it('75 kt ALT hold trace', () => {
  const sim = new ZohSim(2000 * FT, 75, 0, 2, makeEnv());
  console.log(`start: alt ${(sim.ac.altitudeIndicatedM / FT).toFixed(1)} ias ${(sim.ac.aero.ias / KT).toFixed(1)} alpha ${(sim.ac.aero.alpha / DEG).toFixed(2)} thr ${sim.pilot.throttle.toFixed(3)} trim ${sim.pilot.pitchTrim.toFixed(3)} stick ${sim.pilot.pitch.toFixed(3)}`);
  sim.ap.setAltitudeTarget(2000 * FT);
  sim.ap.engage(true); sim.ap.setVertical('ALT'); sim.ap.setHeadingBug(Math.round(sim.ac.headingMagRad / DEG)); sim.ap.setLateral('HDG');
  let next = 0;
  sim.run(60, (s) => {
    if (s.t >= next) {
      next += 4;
      console.log(`t ${s.t.toFixed(1)} alt ${(s.ac.altitudeIndicatedM / FT).toFixed(1)} vs ${(s.ac.verticalSpeedMs / FPM).toFixed(0)} ias ${(s.ac.aero.ias / KT).toFixed(1)} alpha ${(s.ac.aero.alpha / DEG).toFixed(2)} theta ${(s.ac.euler[1] / DEG).toFixed(2)} cmd ${(s.ap.pitchCommandRad / DEG).toFixed(2)} servo ${s.s.outPitch.toFixed(3)} trim ${s.s.trimCommand.toFixed(3)} eng ${s.s.engaged} ${s.s.vertical} rpm ${s.ac.engine.rpm.toFixed(0)}`);
    }
  });
});
