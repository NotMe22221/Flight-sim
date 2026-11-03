import { describe, expect, it } from 'vitest';
import { EngineSynth, type EngineSynthInput } from './EngineSynth';
import { AudioGraph } from './graph';
import { C172_AUDIO_PROFILE } from './profile';
import { PROP_VIEW_GAIN } from './PropellerLayer';
import {
  asAudioContext, MockAudioContext, MockAudioParam, MockConstantSourceNode, MockGainNode, type MockOscillatorNode,
} from './testing/mockAudioContext';

async function setup() {
  const mock = new MockAudioContext();
  const graph = new AudioGraph(() => asAudioContext(mock));
  expect(await graph.resume()).toBe(true);
  const synth = new EngineSynth(graph.ctx as AudioContext, graph.noise!, C172_AUDIO_PROFILE);
  return { mock, synth };
}

const input = (o: Partial<EngineSynthInput> = {}): EngineSynthInput => ({
  rpm: 2400, running: true, manifoldPressureInHg: 24, throttle: null, starter: null,
  thrustN: 1500, tasMs: 50, speedOfSound: 340, ...o,
});

/** Frequency an oscillator param receives: intrinsic target + Σ scaler.gain × constant-source offset. */
function drivenHz(p: MockAudioParam): number {
  let hz = p.target;
  for (const n of p.inputs) {
    if (!(n instanceof MockGainNode)) continue;
    for (const src of n.inputs) if (src instanceof MockConstantSourceNode) hz += n.gain.target * src.offset.target;
  }
  return hz;
}

const oscs = (mock: MockAudioContext) => mock.nodesOfKind<MockOscillatorNode>('oscillator');

describe('EngineSynth', () => {
  it('drives the cycle wavetable so the firing frequency is rpm/30 (2400 rpm → 80 Hz)', async () => {
    const { mock, synth } = await setup();
    for (let i = 0; i < 5; i++) synth.update(1 / 60, input(), false, 1);
    expect(synth.firingHz).toBeCloseTo(80, 9);
    const crank = mock.nodesOfKind<MockConstantSourceNode>('constantSource')[0];
    expect(crank.offset.target).toBeCloseTo(40, 6); // rpm/60
    const cycle = oscs(mock).filter((o) => o.periodicWave && o.periodicWave.real.length === 4 * 40 + 1);
    expect(cycle.length).toBe(2);
    for (const o of cycle) expect(drivenHz(o.frequency) * C172_AUDIO_PROFILE.cylinders).toBeCloseTo(80, 6);
  });

  it('propeller blade-pass follows blades · rpm/60 (2 blades, 2400 rpm → 80 Hz)', async () => {
    const { mock, synth } = await setup();
    synth.update(1 / 60, input(), false, 1);
    const prop = oscs(mock).find((o) => o.periodicWave && o.periodicWave.real.length === 7);
    expect(prop).toBeDefined();
    expect(drivenHz(prop!.frequency)).toBeCloseTo(80, 6);
    expect(synth.prop.toneLevel).toBeGreaterThan(0);
  });

  it('Doppler scales every partial through the single crank control', async () => {
    const { mock, synth } = await setup();
    synth.update(1 / 60, input(), true, 1.25);
    const crank = mock.nodesOfKind<MockConstantSourceNode>('constantSource')[0];
    expect(crank.offset.target).toBeCloseTo(50, 6);
    expect(synth.firingHz).toBeCloseTo(80, 9); // reported pre-Doppler
  });

  it('pulse level rises monotonically with manifold pressure', async () => {
    const { synth } = await setup();
    let prev = -1;
    for (let map = 10; map <= 30; map += 2) {
      synth.update(1 / 60, input({ manifoldPressureInHg: map }), false, 1);
      expect(synth.level).toBeGreaterThanOrEqual(prev);
      expect(synth.level).toBeLessThanOrEqual(1);
      prev = synth.level;
    }
    expect(synth.load).toBe(1); // clamped above max MAP
  });

  it('starter whine during cranking, cough-and-catch envelope on start, ticks on shutdown', async () => {
    const { mock, synth } = await setup();
    synth.update(1 / 60, input({ running: false, rpm: 0, starter: false, manifoldPressureInHg: 29.9 }), false, 1);
    expect(synth.phase).toBe('off');
    for (let i = 0; i < 30; i++) synth.update(1 / 60, input({ running: false, rpm: 200, starter: true, manifoldPressureInHg: 29.9 }), false, 1);
    expect(synth.phase).toBe('cranking');
    const sawGain = mock.nodesOfKind<MockGainNode>('gain').find((g) => Math.abs(g.gain.target - 0.15) < 1e-9);
    expect(sawGain).toBeDefined(); // starter whine gain
    synth.update(1 / 60, input({ running: true, rpm: 600, starter: false, manifoldPressureInHg: 14 }), false, 1);
    expect(synth.phase).toBe('catching');
    const coughs = mock.nodesOfKind<MockGainNode>('gain').filter((g) => g.gain.calls.some((c) => c.type === 'setValueAtTime' && c.value === 2.6));
    expect(coughs.length).toBe(1);
    for (let i = 0; i < 60; i++) synth.update(1 / 60, input({ rpm: 700, manifoldPressureInHg: 12 }), false, 1);
    expect(synth.phase).toBe('running');
    synth.update(1 / 60, input({ running: false, rpm: 650, manifoldPressureInHg: 29 }), false, 1);
    expect(synth.phase).toBe('rundown');
    expect(synth.load).toBe(0);
  });

  it('prop dominates outside, exhaust inside (§A3 balance)', async () => {
    const { synth } = await setup();
    synth.update(1 / 60, input(), true, 1);
    expect((synth.prop.output.gain as unknown as MockAudioParam).target).toBeCloseTo(PROP_VIEW_GAIN.exterior, 9);
    synth.update(1 / 60, input(), false, 1);
    expect((synth.prop.output.gain as unknown as MockAudioParam).target).toBeCloseTo(PROP_VIEW_GAIN.interior, 9);
  });

  it('never writes .value directly, survives NaN inputs, disposes every node', async () => {
    const { mock, synth } = await setup();
    for (let i = 0; i < 120; i++) synth.update(1 / 60, input({ rpm: 700 + i * 15 }), i % 2 === 0, 1 + i * 1e-3);
    synth.update(1 / 60, input({ rpm: Number.NaN, manifoldPressureInHg: Number.NaN, tasMs: Number.NaN }), false, Number.NaN);
    expect(mock.directValueWrites).toEqual([]);
    for (const p of mock.allParams()) for (const c of p.calls) if ('value' in c) expect(Number.isFinite(c.value)).toBe(true);
    expect(synth.nodeCount).toBeGreaterThan(20);
    expect(synth.nodeCount).toBeLessThan(60);
    synth.dispose();
    expect(mock.liveSources().filter((s) => !s.stopped)).toEqual([]); // every oscillator / loop stopped
  });
});
