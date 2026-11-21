import { describe, expect, it } from 'vitest';
import { C172S } from './aircraft/c172';
import { PA18_150 } from './aircraft/cub';
import { PistonPropulsion } from './propulsion';
import type { PistonEngineSpec } from '../core/types';
import { atmosphere } from './atmosphere';

/** Relative power of a lever setting in this engine model (fuel/air × efficiency, capped at best power). */
const power = (p: PistonPropulsion, mixture: number, pAmb: number) => p.relativePower(mixture, pAmb);

describe('auto-mixture target (peakPowerMixture)', () => {
  for (const cfg of [C172S, PA18_150]) {
    it(`${cfg.id}: never gives less power than full rich, sea level to 10,000 ft`, () => {
      const p = new PistonPropulsion(cfg.propulsion.engine as PistonEngineSpec, cfg.propulsion.propeller!);
      for (const altM of [0, 600, 1200, 2000, 3000]) {
        const pAmb = atmosphere(altM).pressurePa;
        const m = p.peakPowerMixture(pAmb);
        expect(m).toBeGreaterThan(0.3);
        expect(m).toBeLessThanOrEqual(1);
        expect(power(p, m, pAmb)).toBeGreaterThanOrEqual(power(p, 1, pAmb) - 1e-9);
        // the old target (the POH lean point) lost ~6 % at sea level and ~11 % at 4,000 ft
        expect(power(p, m, pAmb)).toBeGreaterThanOrEqual(power(p, p.bestPowerMixture(pAmb), pAmb));
      }
    });
  }

  it('the assist finds best power, never the over-rich hump of the old fuel × efficiency (no power from fuel without oxygen)', () => {
    const p = new PistonPropulsion(C172S.propulsion.engine as PistonEngineSpec, C172S.propulsion.propeller!);
    for (const altM of [0, 2438, 3000]) {
      const pAmb = atmosphere(altM).pressurePa;
      const best = p.relativePower(p.peakPowerMixture(pAmb), pAmb);
      // no lever setting beats the full-efficiency peak by more than rounding
      for (let m = 0.3; m <= 1; m += 0.01) expect(p.relativePower(m, pAmb)).toBeLessThanOrEqual(best + 1e-9);
      expect(p.fuelAirRatio(p.peakPowerMixture(pAmb), pAmb)).toBeLessThan(0.095);
    }
  });
});
