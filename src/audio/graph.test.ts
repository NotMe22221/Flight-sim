import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAircraftState } from '../core/fakeState';
import { AudioSystem } from './AudioSystem';
import { AudioGraph, BUS_NAMES, DEFAULT_BUS_VOLUMES, DEFAULT_MASTER_VOLUME, NOISE_LOOP_S } from './graph';
import { SmoothParam } from './params';
import { makeCamera, makeWeather } from './testing/fixtures';
import { asAudioContext, MockAudioContext, type MockAudioNode, type MockAudioParam } from './testing/mockAudioContext';

const P = (p: AudioParam) => p as unknown as MockAudioParam;

describe('AudioGraph lifecycle', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('creates the context lazily on the first resume and reuses it', async () => {
    const factory = vi.fn(() => asAudioContext(new MockAudioContext()));
    const g = new AudioGraph(factory);
    expect(g.ctx).toBeNull();
    expect(g.state).toBe('none');
    expect(g.now()).toBe(0);
    expect(factory).not.toHaveBeenCalled();
    expect(await g.resume()).toBe(true);
    expect(await g.resume()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(g.running).toBe(true);
    g.dispose();
    expect(g.ctx).toBeNull();
  });

  it('reports unavailability once and stays silent', async () => {
    const factory = vi.fn(() => null);
    const g = new AudioGraph(factory);
    expect(await g.resume()).toBe(false);
    expect(await g.resume()).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(() => { g.setBusVolume('engine', 1); g.setMasterVolume(1); g.setMuted(true); g.dispose(); }).not.toThrow();
  });

  it('builds the buses with default volumes, a safety limiter and shared noise loops', async () => {
    const m = new MockAudioContext({ sampleRate: 44100 });
    const g = new AudioGraph(() => asAudioContext(m));
    await g.resume();
    const b = g.buses!;
    for (const n of BUS_NAMES) expect(P(b.bus[n].gain).target).toBe(DEFAULT_BUS_VOLUMES[n]);
    expect(P(b.master.gain).target).toBe(DEFAULT_MASTER_VOLUME);
    expect(P(b.limiter.threshold).target).toBe(-12);
    expect(P(b.limiter.ratio).target).toBe(4);
    expect(g.noise!.white.length).toBe(44100 * NOISE_LOOP_S);
    expect(g.noise!.pink.duration).toBeCloseTo(NOISE_LOOP_S, 6);
    expect(g.noise!.crackle.duration).toBeCloseTo(2, 6);
    // ui / atc / cockpit reach the master; engine & environment wait for a ViewStage
    const outs = (n: AudioNode) => (n as unknown as MockAudioNode).outputs;
    expect(outs(b.bus.ui)).toContain(b.master);
    expect(outs(b.bus.atc)).toContain(b.master);
    expect(outs(b.bus.engine)).toEqual([]);
    expect(m.audibleDirectWrites()).toEqual([]);
  });

  it('clamps volumes and glides them with setTargetAtTime', async () => {
    const g = new AudioGraph(() => asAudioContext(new MockAudioContext()));
    await g.resume();
    g.setBusVolume('ui', 5);
    expect(g.busVolume('ui')).toBe(2);
    g.setBusVolume('atc', Number.NaN);
    expect(g.busVolume('atc')).toBe(0);
    g.setMasterVolume(0.8);
    expect(P(g.buses!.master.gain).last('setTargetAtTime')?.value).toBe(0.8);
    g.setMuted(true);
    expect(P(g.buses!.master.gain).target).toBe(0);
    g.setMasterVolume(0.6); // stored, not applied while muted
    expect(P(g.buses!.master.gain).target).toBe(0);
    g.setMuted(false);
    expect(P(g.buses!.master.gain).target).toBe(0.6);
  });

  it('wakes a suspended / interrupted context on later gestures and when the tab becomes visible', async () => {
    const handlers = new Map<string, () => void>();
    vi.stubGlobal('addEventListener', (type: string, fn: () => void) => { handlers.set(type, fn); });
    vi.stubGlobal('removeEventListener', (type: string) => { handlers.delete(type); });
    const doc = { visibilityState: 'hidden', addEventListener: (t: string, fn: () => void) => handlers.set(`doc:${t}`, fn), removeEventListener: (t: string) => handlers.delete(`doc:${t}`) };
    vi.stubGlobal('document', doc);
    const m = new MockAudioContext();
    const g = new AudioGraph(() => asAudioContext(m));
    await g.resume();
    expect([...handlers.keys()].sort()).toEqual(['doc:visibilitychange', 'keydown', 'pointerdown', 'touchend']);
    m.setState('interrupted');
    const calls = m.resumeCalls;
    handlers.get('pointerdown')!();
    expect(m.resumeCalls).toBe(calls + 1);
    expect(g.running).toBe(true);
    handlers.get('keydown')!(); // running: cheap no-op
    expect(m.resumeCalls).toBe(calls + 1);
    m.setState('suspended');
    handlers.get('doc:visibilitychange')!(); // still hidden
    expect(m.resumeCalls).toBe(calls + 1);
    doc.visibilityState = 'visible';
    handlers.get('doc:visibilitychange')!();
    expect(m.resumeCalls).toBe(calls + 2);
    g.dispose();
    expect(handlers.size).toBe(0);
  });
});

describe('SmoothParam', () => {
  it('skips negligible changes and ignores non-finite targets', () => {
    const m = new MockAudioContext();
    const p = P(asAudioContext(m).createGain().gain);
    const s = new SmoothParam(p as unknown as AudioParam, 0.05, 1e-3, 0.01);
    expect(s.set(0.5, 0)).toBe(true);
    expect(s.set(0.502, 0.1)).toBe(false);
    expect(s.set(0.6, 0.2)).toBe(true);
    expect(s.set(Number.NaN, 0.3)).toBe(false);
    expect(s.target).toBe(0.6);
    expect(p.callCount).toBe(2);
    expect(p.last('setTargetAtTime')?.tau).toBe(0.05);
  });
});

describe('CPU budget', () => {
  it('keeps the persistent node count bounded and nothing grows per frame', async () => {
    const m = new MockAudioContext();
    const sys = new AudioSystem({ contextFactory: () => asAudioContext(m), speech: null });
    await sys.resume();
    const ac = makeAircraftState({ engine: { ...makeAircraftState().engine, running: true, rpm: 2300, manifoldPressureInHg: 22 } });
    sys.update(1 / 60, ac, makeCamera(), makeWeather());
    const persistent = m.nodes.length;
    expect(persistent).toBeLessThan(140);
    for (let i = 0; i < 600; i++) { sys.update(1 / 60, ac, makeCamera(), makeWeather()); m.advance(1 / 60); }
    expect(m.nodes.length).toBe(persistent); // no per-frame node creation
    // steady state schedules (almost) no automation: SmoothParam skips unchanged targets
    const calls = m.allParams().reduce((n, p) => n + p.callCount, 0);
    sys.update(1 / 60, ac, makeCamera(), makeWeather());
    expect(m.allParams().reduce((n, p) => n + p.callCount, 0) - calls).toBeLessThanOrEqual(2);
  });
});
