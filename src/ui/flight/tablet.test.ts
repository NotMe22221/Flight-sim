import { describe, expect, it } from 'vitest';
import type { Airport } from '../../core/types';
import { C172S } from '../../fdm/aircraft/c172';
import { PA18_150 } from '../../fdm/aircraft/cub';
import { computeMassProperties } from '../../fdm/massProps';
import { directRoute, legSummary } from './TabletFlightPlan';
import { cgFraction } from './TabletWeightFuel';

const ap = (icao: string, lat: number, lon: number, elevationM: number) => ({ icao, name: icao, position: { lat, lon, alt: elevationM }, elevationM } as unknown as Airport);

describe('EFB tablet maths', () => {
  it('direct route: departure carries the cruise altitude, the destination its elevation', () => {
    const r = directRoute(ap('KSFO', 37.6188, -122.375, 4), ap('KOAK', 37.7213, -122.2207, 3), 4500);
    expect(r.map((w) => w.id)).toEqual(['KSFO', 'KOAK']);
    expect(r.every((w) => w.type === 'airport')).toBe(true);
    expect(r[0].altConstraintM).toBeCloseTo(4500 * 0.3048, 6);
    expect(r[1].altConstraintM).toBe(3);
  });

  it('leg summary: KSFO → KOAK ≈ 9.7 nm, ≈ 5 min at 115 kt', () => {
    const s = legSummary({ lat: 37.6188, lon: -122.375, alt: 0 }, { lat: 37.7213, lon: -122.2207, alt: 0 }, 115);
    expect(s.nm).toBeGreaterThan(9); expect(s.nm).toBeLessThan(10.5);
    expect(s.minutes).toBeCloseTo((s.nm / 115) * 60, 9);
    expect(legSummary({ lat: 0, lon: 0, alt: 0 }, { lat: 1, lon: 0, alt: 0 }, 0).minutes).toBe(0);
  });

  it('CG bar: 0 at the forward limit, 1 at the aft limit, outside beyond them', () => {
    const lim: [number, number] = [0.3, -0.1];
    expect(cgFraction(0.3, lim)).toBeCloseTo(0, 9);
    expect(cgFraction(-0.1, lim)).toBeCloseTo(1, 9);
    expect(cgFraction(0.1, lim)).toBeCloseTo(0.5, 9);
    expect(cgFraction(0.4, lim)).toBeLessThan(0);
    expect(cgFraction(-0.3, lim)).toBeGreaterThan(1);
  });

  it('the shipped loadings sit inside the published CG envelopes (172S POH, PA-18 TCDS)', () => {
    for (const cfg of [C172S, PA18_150]) {
      const lim = cfg.mass.cgLimitsM!;
      expect(lim[0]).toBeGreaterThan(lim[1]); // forward limit ahead of the aft limit (x forward)
      const mp = computeMassProperties(cfg, cfg.mass.stations.map((s) => s.massKg), cfg.mass.tanks.map((t) => t.contentsKg));
      const f = cgFraction(mp.cg[0], lim);
      expect(f, cfg.id).toBeGreaterThan(0); expect(f, cfg.id).toBeLessThan(1);
    }
  });
});
