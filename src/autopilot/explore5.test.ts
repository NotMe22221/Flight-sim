import { it } from 'vitest';
import type { TurbulenceIntensity } from '../core/types';
import { DEG, FT, KT } from '../core/units';
import { makeEnv } from '../fdm/testing';
import { ZohSim } from './reviewHarness';

it('chirp scenarios', () => {
  for (const [kcas, flaps] of [[75, 1], [70, 2]] as const) {
    for (const intensity of [4, 5] as TurbulenceIntensity[]) {
      for (const persist of [0, 0.5, 1]) {
        const sim = new ZohSim(1500 * FT, kcas, 0, 2, makeEnv({ turbulence: { w20Kt: 0, intensity, seed: 1 } }));
        sim.ap.config.protections.warningPersistS = persist;
        sim.pilot.flapsIndex = flaps;
        const thr0 = sim.pilot.throttle;
        sim.pilotHook = (s) => { s.pilot.throttle = Math.min(1, Math.max(0, thr0 + 0.1 + 0.08 * (kcas - s.ac.aero.ias / KT))); };
        sim.run(2);
        sim.ap.setAltitudeTarget(sim.ac.altitudeIndicatedM);
        sim.ap.engage(true); sim.ap.setVertical('ALT'); sim.ap.setHeadingBug(Math.round(sim.ac.headingMagRad / DEG)); sim.ap.setLateral('HDG');
        let chirps = 0, was = false, longest = 0, run = 0, minIas = Infinity, stalledEngaged = false, maxAlphaEng = 0;
        sim.run(180, (s) => {
          const w = s.ac.aero.stallWarning;
          if (w && !was) chirps++;
          was = w; run = w ? run + 1 : 0; longest = Math.max(longest, run);
          if (s.s.engaged) { minIas = Math.min(minIas, s.ac.aero.ias / KT); stalledEngaged ||= s.ac.aero.stalled; maxAlphaEng = Math.max(maxAlphaEng, s.ac.aero.alpha); }
        });
        console.log(`${kcas} kt flaps ${flaps} turb ${intensity} persist ${persist}: chirps ${chirps} longest ${(longest / 60).toFixed(2)} s engaged ${sim.s.engaged} ${sim.s.disconnectReason ?? ''} at ${Number.isFinite(sim.s.disconnectT) ? sim.s.disconnectT.toFixed(1) : '-'} minIas(engaged) ${minIas.toFixed(1)} stalledWhileEngaged ${stalledEngaged} maxAlphaEngaged ${(maxAlphaEng / DEG).toFixed(1)}`);
      }
    }
  }
});
