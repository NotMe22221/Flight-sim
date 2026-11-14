import { describe, expect, it } from 'vitest';
import { C172S } from './aircraft/c172';
import { PA18_150 } from './aircraft/cub';
import { PistonPropulsion } from './propulsion';
import type { PistonEngineSpec } from '../core/types';
import { atmosphere } from './atmosphere';

/** Relative power of a lever setting in this engine model: fuel/air ratio x mixture efficiency. */
const power = (p: PistonPropulsion, mixture: number, pAmb: number) => {
  const fa = p.fuelAirRatio(mixture, pAmb);
  return fa * p.mixtureEfficiency(fa);
};

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
});
