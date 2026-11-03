import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { AircraftState } from '../core/types';
import { DEG } from '../core/units';
import { EnvironmentSynth } from './Environment';
import { buffetIntensity, rollLevel, whistleHz, windCutoffHz, windLevel } from './environmentLaws';
import { C172_AUDIO_PROFILE } from './profile';
import { makeRunningGraph, makeWeather } from './testing/fixtures';
import type { MockGainNode } from './testing/mockAudioContext';

async function setup() {
  const { mock, graph, ctx } = await makeRunningGraph();
  const b = graph.buses!;
  const env = new EnvironmentSynth(ctx, graph.noise!, b.bus.environment, b.bus.cockpit, C172_AUDIO_PROFILE);
  return { mock, env };
}

const flying = (ias: number, o: Partial<AircraftState> = {}): AircraftState => {
  const s = makeAircraftState({ onGround: false, ...o });
  s.aero = { ...s.aero, ias, tas: ias, ...(o.aero ?? {}) };
  s.gear = s.gear.map((g) => ({ ...g, onGround: false, wheelSpeedMs: 0 }));
  return s;
};

const rolling = (v: number): AircraftState => {
  const s = makeAircraftState({ onGround: true, groundSpeedMs: v });
  s.aero = { ...s.aero, ias: v };
  s.gear = s.gear.map((g) => ({ ...g, onGround: true, wheelSpeedMs: v }));
  return s;
};

describe('environment laws', () => {
  it('wind level ∝ IAS² (below the cap), with a sweeping whistle', () => {
    expect(windLevel(20) / windLevel(10)).toBeCloseTo(4, 9);
    expect(windLevel(60) / windLevel(30)).toBeCloseTo(4, 9);
    expect(windLevel(0)).toBe(0);
    expect(windLevel(500)).toBeLessThanOrEqual(1);
    expect(windLevel(40, 30)).toBeGreaterThan(windLevel(40, 0));
    expect(whistleHz(60)).toBeGreaterThan(whistleHz(20));
    expect(windCutoffHz(70)).toBeCloseTo(2800, 6);
  });
  it('buffet only near / at the stall and only with airflow', () => {
    const a = C172_AUDIO_PROFILE.alphaStallRad;
    expect(buffetIntensity(flying(40, { aero: { ...makeAircraftState().aero, ias: 40, alpha: 5 * DEG } }), a)).toBe(0);
    const warn = flying(30);
    warn.aero.stallWarning = true;
    expect(buffetIntensity(warn, a)).toBeGreaterThanOrEqual(0.3);
    const st = flying(28);
    st.aero.stalled = true;
    expect(buffetIntensity(st, a)).toBe(1);
    const parked = makeAircraftState();
    parked.aero = { ...parked.aero, stallWarning: true, ias: 0 };
    expect(buffetIntensity(parked, a)).toBe(0);
  });
  it('grass rolls louder than pavement; silent when stopped', () => {
    expect(rollLevel(20, 'grass')).toBeGreaterThan(rollLevel(20, 'paved'));
    expect(rollLevel(0, 'paved')).toBe(0);
  });
});

describe('EnvironmentSynth', () => {
  it('wind gain target follows IAS²', async () => {
    const { env } = await setup();
    env.update(1 / 60, flying(20), makeWeather(), 'paved');
    const w20 = env.windGain;
    env.update(1 / 60, flying(40), makeWeather(), 'paved');
    expect(env.windGain / w20).toBeCloseTo(4, 6);
  });

  it('rain hiss with rain, silence with snow', async () => {
    const { env } = await setup();
    env.update(1 / 60, flying(50), makeWeather({ precipitationType: 'rain', precipitationRate: 8 }), 'paved');
    expect(env.rainGain).toBeGreaterThan(0);
    env.update(1 / 60, flying(50), makeWeather({ precipitationType: 'snow', precipitationRate: 8 }), 'paved');
    expect(env.rainGain).toBe(0);
  });

  it('ground roll only on the ground, rising with wheel speed', async () => {
    const { env } = await setup();
    env.update(1 / 60, flying(30), makeWeather(), 'paved');
    expect(env.rollGain).toBe(0);
    env.update(1 / 60, rolling(10), makeWeather(), 'paved');
    const slow = env.rollGain;
    env.update(1 / 60, rolling(30), makeWeather(), 'paved');
    expect(env.rollGain).toBeGreaterThan(slow);
    env.update(1 / 60, rolling(30), makeWeather(), 'grass');
    expect(env.rollGain).toBeGreaterThan(rollLevel(30, 'paved'));
  });

  it('flap motor whines while flapDeg moves and stops after it settles', async () => {
    const { env } = await setup();
    const s = flying(40);
    env.update(1 / 60, s, makeWeather(), 'paved');
    expect(env.flapMotorRunning).toBe(false);
    for (let i = 0; i < 30; i++) { s.surfaces = { ...s.surfaces, flapDeg: i * (10 / 2.9) / 60 }; env.update(1 / 60, s, makeWeather(), 'paved'); }
    expect(env.flapMotorRunning).toBe(true);
    for (let i = 0; i < 20; i++) env.update(1 / 60, s, makeWeather(), 'paved');
    expect(env.flapMotorRunning).toBe(false);
  });

  it('touchdown thump/chirp voices are transient and clean up after themselves', async () => {
    const { mock, env } = await setup();
    env.update(1 / 60, rolling(28), makeWeather(), 'paved');
    mock.advance(0.05); // let the graph's iOS-unlock blip end
    const before = mock.liveSources().length;
    env.onTouchdown(-2.5, 0.5);
    const during = mock.liveSources().length;
    expect(during - before).toBe(3); // thump tone, thump noise, chirp
    const thumpGain = mock.nodesOfKind<MockGainNode>('gain').find((g) => g.gain.calls.some((c) => c.type === 'linearRampToValueAtTime' && Math.abs(c.value - 0.9 * (2.5 / 3)) < 1e-9));
    expect(thumpGain).toBeDefined();
    mock.advance(2);
    expect(mock.liveSources().length).toBe(before);
    expect(mock.audibleDirectWrites()).toEqual([]);
  });

  it('a soft, slow touchdown skips the chirp', async () => {
    const { mock, env } = await setup();
    const before = mock.liveSources().length;
    env.onTouchdown(-0.3, 0, 0.5);
    expect(mock.liveSources().length - before).toBe(2);
  });
});
