import { describe, it } from 'vitest';
import { deltaDeg } from '../core/math';
import { DEG, FPM, FT, KT } from '../core/units';
import { ZohSim } from './reviewHarness';

const SUBS = [1, 2, 4, 8, 16];

describe('explore', () => {
  it('HDG 000->090 across AP rates', () => {
    for (const sub of SUBS) {
      const sim = new ZohSim(3000 * FT, 100, 0, sub);
      sim.ap.engage(true); sim.ap.setHeadingBug(90); sim.ap.setLateral('HDG');
      let maxBank = 0, maxOver = 0, cap = -1, maxRollOsc = 0;
      sim.run(90, (s) => {
        maxBank = Math.max(maxBank, Math.abs(s.ac.euler[0]) / DEG);
        const e = deltaDeg(s.ac.headingMagRad / DEG, 90);
        maxOver = Math.max(maxOver, e);
        if (cap < 0 && Math.abs(e) < 2) cap = s.t;
        if (s.t > 60) maxRollOsc = Math.max(maxRollOsc, Math.abs(s.ac.euler[0]) / DEG);
      });
      console.log(`HDG sub=${sub} (${(120 / sub).toFixed(1)} Hz): cap ${cap.toFixed(1)} s over ${maxOver.toFixed(2)} maxBank ${maxBank.toFixed(1)} late |roll| ${maxRollOsc.toFixed(2)} final err ${deltaDeg(sim.ac.headingMagRad / DEG, 90).toFixed(2)} eng ${sim.s.engaged} ${sim.s.disconnectReason}`);
    }
  });

  it('HDG wrap 350->010 and 010->350', () => {
    for (const [h0, bug] of [[350, 10], [10, 350], [359, 1], [1, 359], [180, 179], [0, 180]] as const) {
      const sim = new ZohSim(3000 * FT, 100, h0, 2);
      sim.ap.engage(true); sim.ap.setHeadingBug(bug); sim.ap.setLateral('HDG');
      let firstRollSign = 0;
      sim.run(60, (s) => { if (firstRollSign === 0 && Math.abs(s.ac.euler[0]) > 2 * DEG) firstRollSign = Math.sign(s.ac.euler[0]); });
      console.log(`wrap ${h0}->${bug}: first roll ${firstRollSign > 0 ? 'right' : firstRollSign < 0 ? 'left' : 'none'} final hdg ${(sim.ac.headingMagRad / DEG).toFixed(2)} magvar ${((sim.ac.headingTrueRad - sim.ac.headingMagRad) / DEG).toFixed(2)}`);
    }
  });

  it('ALT 3000->3500 across AP rates', () => {
    for (const sub of SUBS) {
      const sim = new ZohSim(3000 * FT, 100, 0, sub);
      sim.pilot.throttle = 1;
      sim.ap.engage(true); sim.ap.setAltitudeTarget(3500 * FT); sim.ap.setVertical('ALT');
      let maxVs = 0, maxAlt = 0, late = 0;
      sim.run(150, (s) => {
        maxVs = Math.max(maxVs, s.ac.verticalSpeedMs / FPM);
        maxAlt = Math.max(maxAlt, s.ac.altitudeIndicatedM / FT);
        if (s.t > 100) late = Math.max(late, Math.abs(s.ac.altitudeIndicatedM / FT - 3500));
      });
      console.log(`ALT sub=${sub}: maxVs ${maxVs.toFixed(0)} over ${(maxAlt - 3500).toFixed(1)} late err ${late.toFixed(1)} mode ${sim.s.vertical} eng ${sim.s.engaged} trim ${sim.s.trimCommand.toFixed(3)} servo ${sim.s.outPitch.toFixed(3)}`);
    }
  });

  it('FLC 80 kt climb and idle descent across rates', () => {
    for (const sub of [1, 2, 4, 8, 16]) {
      const sim = new ZohSim(3000 * FT, 90, 0, sub);
      sim.ap.setAltitudeTarget(9000 * FT);
      sim.ap.engage(true); sim.ap.setIasTarget(80 * KT); sim.ap.setVertical('FLC');
      sim.pilot.throttle = 1;
      let maxErr = 0;
      sim.run(120, (s) => { if (s.t > 25) maxErr = Math.max(maxErr, Math.abs(s.ac.aero.ias / KT - 80)); });
      console.log(`FLC climb sub=${sub}: max IAS err ${maxErr.toFixed(2)} vs ${(sim.ac.verticalSpeedMs / FPM).toFixed(0)} eng ${sim.s.engaged} ${sim.s.disconnectReason}`);
    }
  });
});
