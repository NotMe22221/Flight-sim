/** The audio profile follows the aircraft: the Super Cub's O-320, 74 in prop, 8.00-6 tyres and manual flaps. */
import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { AircraftState } from '../core/types';
import { DEG } from '../core/units';
import { C172S } from '../fdm/aircraft/c172';
import { PA18_150 } from '../fdm/aircraft/cub';
import { EnvironmentSynth } from './Environment';
import { audioProfileFromConfig } from './profile';
import { makeRunningGraph, makeWeather } from './testing/fixtures';

const flying = (ias: number): AircraftState => {
  const s = makeAircraftState({ onGround: false });
  s.aero = { ...s.aero, ias, tas: ias };
  s.gear = s.gear.map((g) => ({ ...g, onGround: false, wheelSpeedMs: 0 }));
  return s;
};

describe('Super Cub audio profile', () => {
  it('is built from the PA-18-150 configuration', () => {
    const p = audioProfileFromConfig(PA18_150);
    expect(p.cylinders).toBe(4);
    expect(p.ratedRpm).toBe(2700);
    expect(p.propBlades).toBe(2);
    expect(p.propDiameterM).toBeCloseTo(1.88, 2);
    expect(p.mainTyreRadiusM).toBeCloseTo(0.28, 2);
    expect(p.alphaStallRad).toBeCloseTo(15.5 * DEG, 2);
    expect(p.alphaWarnRad).toBeLessThan(p.alphaStallRad);
    expect(p.electricFlaps).toBe(false);
    expect(audioProfileFromConfig(C172S).electricFlaps).toBe(true);
  });

  it('a manual flap handle makes no motor whine', async () => {
    const { graph, ctx } = await makeRunningGraph();
    const b = graph.buses!;
    const env = new EnvironmentSynth(ctx, graph.noise!, b.bus.environment, b.bus.cockpit, audioProfileFromConfig(PA18_150));
    const s = flying(40);
    env.update(1 / 60, s, makeWeather(), 'paved');
    for (let i = 0; i < 30; i++) { s.surfaces = { ...s.surfaces, flapDeg: i * 0.5 }; env.update(1 / 60, s, makeWeather(), 'paved'); }
    expect(env.flapMotorRunning).toBe(false);
  });
});
