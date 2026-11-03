import { describe, expect, it } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import type { AircraftState } from '../core/types';
import { DEG } from '../core/units';
import { PatternGate } from './PatternGate';
import { C172_AUDIO_PROFILE, type AudioProfile } from './profile';
import { makeRunningGraph } from './testing/fixtures';
import { asAudioContext, type MockGainNode, MockAudioContext, type MockOscillatorNode } from './testing/mockAudioContext';
import { MARKER_TONES, STALL_HORN, stallHornIntensity, Warnings } from './Warnings';

async function setup(profile: AudioProfile = C172_AUDIO_PROFILE) {
  const { mock, graph, ctx } = await makeRunningGraph();
  const b = graph.buses!;
  const w = new Warnings(ctx, graph.noise!, b.bus.cockpit, b.bus.ui, profile);
  mock.advance(0.05);
  return { mock, w };
}

const stallState = (alphaDeg: number, warning: boolean, stalled = false): AircraftState => {
  const s = makeAircraftState({ onGround: false });
  s.aero = { ...s.aero, alpha: alphaDeg * DEG, ias: 25, stallWarning: warning, stalled };
  s.warnings = { ...s.warnings, stall: warning };
  return s;
};

describe('stall horn', () => {
  const P = C172_AUDIO_PROFILE;
  it('is gated by the stall warning', () => {
    expect(stallHornIntensity(stallState(15, false), P.alphaWarnRad, P.alphaStallRad)).toBe(0);
    expect(stallHornIntensity(stallState(12, true), P.alphaWarnRad, P.alphaStallRad)).toBeCloseTo(STALL_HORN.minIntensity, 9);
  });
  it('gets louder as α rises toward the break; full when stalled', () => {
    const lo = stallHornIntensity(stallState(12.5, true), P.alphaWarnRad, P.alphaStallRad);
    const hi = stallHornIntensity(stallState(15.5, true), P.alphaWarnRad, P.alphaStallRad);
    expect(hi).toBeGreaterThan(lo);
    expect(stallHornIntensity(stallState(10, true, true), P.alphaWarnRad, P.alphaStallRad)).toBe(1);
    expect(stallHornIntensity(stallState(40, true), P.alphaWarnRad, P.alphaStallRad)).toBeLessThanOrEqual(1);
  });
  it('drives the horn gain and reed pitch (~2.1 kHz) in the graph', async () => {
    const { mock, w } = await setup();
    const hornGain = () => Math.max(...mock.nodesOfKind<MockGainNode>('gain').filter((g) => g.outputs.length && g.gain.calls.some((c) => c.type === 'setTargetAtTime')).map((g) => g.gain.target));
    w.update(stallState(14, false));
    expect(w.stallHorn).toBe(0);
    w.update(stallState(14, true));
    expect(w.stallHorn).toBeGreaterThan(0);
    expect(hornGain()).toBeCloseTo(STALL_HORN.gain * w.stallHorn, 9);
    const saw = mock.nodesOfKind<MockOscillatorNode>('oscillator').find((o) => o.type === 'sawtooth')!;
    expect(saw.frequency.target).toBeGreaterThan(1900);
    expect(saw.frequency.target).toBeLessThan(2300);
    w.update(stallState(14, false));
    expect(w.stallHorn).toBe(0);
  });
});

describe('PatternGate', () => {
  it('schedules marker keying edges ahead of the clock, without bursts after a stall', () => {
    const mock = new MockAudioContext();
    const g = asAudioContext(mock).createGain();
    const gate = new PatternGate(g.gain, 0.002, 0.12);
    gate.start(MARKER_TONES.inner.pattern, 0, 1);
    const edgesAt = (from: number) => (g.gain as unknown as MockGainNode['gain']).calls.filter((c) => c.type === 'setTargetAtTime' && c.time >= from);
    for (let t = 0; t <= 1.0 + 1e-9; t += 1 / 60) gate.update(t);
    // inner marker: 6 dots per second → 12 edges per second
    const firstSecond = edgesAt(0).filter((c) => c.time < 1.0);
    expect(firstSecond.length).toBeGreaterThanOrEqual(11);
    expect(firstSecond.length).toBeLessThanOrEqual(13);
    const n = gate.edges;
    gate.update(10); // render loop paused for 9 s
    expect(gate.edges - n).toBeLessThanOrEqual(3);
    gate.stop(10);
    expect(gate.active).toBe(false);
  });
  it('rejects malformed patterns', () => {
    const mock = new MockAudioContext();
    const gate = new PatternGate(asAudioContext(mock).createGain().gain);
    expect(() => gate.start([0.1], 0)).toThrow();
  });
});

describe('Warnings', () => {
  it('marker beacon tones use 400 / 1300 / 3000 Hz', async () => {
    const { mock, w } = await setup();
    const tone = () => mock.nodesOfKind<MockOscillatorNode>('oscillator').find((o) => o.type === 'sine' && [400, 1300, 3000].includes(o.frequency.target));
    w.setMarker('middle');
    w.update(makeAircraftState());
    expect(tone()?.frequency.target).toBe(1300);
    w.setMarker('inner');
    expect(tone()?.frequency.target).toBe(3000);
    w.setMarker(null);
    expect(w.markerBeacon).toBeNull();
  });

  it('overspeed clacker only on aircraft that have one', async () => {
    const over = makeAircraftState({ warnings: { ...makeAircraftState().warnings, overspeed: true } });
    const c172 = await setup();
    c172.w.update(over);
    expect(c172.w.clacking).toBe(false);
    const jet = await setup({ ...C172_AUDIO_PROFILE, overspeedClacker: true });
    jet.w.update(over);
    expect(jet.w.clacking).toBe(true);
    jet.w.update(makeAircraftState());
    expect(jet.w.clacking).toBe(false);
  });

  it('UI sounds, AP disconnect and altitude alert are transient voices that clean up', async () => {
    const { mock, w } = await setup();
    const base = mock.liveSources().length;
    for (const k of ['click', 'switch', 'warn', 'confirm', 'error'] as const) w.playUi(k);
    w.apDisconnect();
    w.altitudeAlert();
    expect(mock.liveSources().length).toBeGreaterThan(base + 10);
    mock.advance(5);
    expect(mock.liveSources().length).toBe(base);
    expect(mock.audibleDirectWrites()).toEqual([]);
  });
});
