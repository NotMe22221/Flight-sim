import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/events';
import { makeAircraftState } from '../core/fakeState';
import { type AircraftState, type AutopilotState, defaultControlInputs, type SimSnapshot } from '../core/types';
import { DEG } from '../core/units';
import { C172S } from '../fdm/aircraft/c172';
import { AudioSystem } from './AudioSystem';
import { makeCamera, makeWeather } from './testing/fixtures';
import { asAudioContext, MockAudioContext, type MockAudioNode, type MockAudioParam, type MockGainNode } from './testing/mockAudioContext';
import { VIEW } from './ViewStage';

const DT = 1 / 60;

function mockSystem(opts: { state?: 'suspended' | 'running'; rejectResume?: boolean; events?: EventBus } = {}) {
  const mocks: MockAudioContext[] = [];
  const sys = new AudioSystem({
    contextFactory: () => { const m = new MockAudioContext({ state: opts.state, rejectResume: opts.rejectResume }); mocks.push(m); return asAudioContext(m); },
    speech: null,
    events: opts.events,
  });
  return { sys, mocks };
}

/** A short scripted flight: start, run-up, takeoff roll, climb, stall, landing roll. */
function* flight(): Generator<AircraftState> {
  const s = makeAircraftState();
  for (let i = 0; i < 60; i++) { s.engine = { ...s.engine, rpm: Math.min(200, i * 10), running: false }; yield s; }
  for (let i = 0; i < 60; i++) { s.engine = { ...s.engine, rpm: 650 + i * 30, running: true, manifoldPressureInHg: 12 + i * 0.25, thrustN: i * 30 }; yield s; }
  for (let i = 0; i < 60; i++) {
    const v = i * 0.5;
    s.groundSpeedMs = v; s.aero = { ...s.aero, ias: v, tas: v };
    s.gear = s.gear.map((g) => ({ ...g, onGround: true, wheelSpeedMs: v }));
    s.velNED = [v, 0, 0];
    yield s;
  }
  s.onGround = false;
  s.gear = s.gear.map((g) => ({ ...g, onGround: false, wheelSpeedMs: 0 }));
  for (let i = 0; i < 60; i++) {
    s.aero = { ...s.aero, ias: 35 - i * 0.2, alpha: (8 + i * 0.15) * DEG, stallWarning: i > 20, stalled: i > 45 };
    s.surfaces = { ...s.surfaces, flapDeg: Math.min(10, i * 0.06) };
    s.posNED = [s.posNED[0] + 0.6, 0, -50];
    yield s;
  }
  s.onGround = true;
  s.aero = { ...s.aero, stallWarning: false, stalled: false, alpha: 4 * DEG, ias: 25 };
  s.gear = s.gear.map((g) => ({ ...g, onGround: true, wheelSpeedMs: 25 }));
  for (let i = 0; i < 30; i++) yield s;
}

describe('AudioSystem headless', () => {
  it('without an AudioContext every call is a silent no-op that never throws', async () => {
    const sys = new AudioSystem({ contextFactory: () => null, speech: null });
    await expect(sys.resume()).resolves.toBeUndefined();
    expect(sys.ready).toBe(false);
    const ac = makeAircraftState();
    expect(() => {
      sys.update(DT, ac, makeCamera(), makeWeather());
      sys.update(Number.NaN, ac, makeCamera('drone'), makeWeather());
      sys.setMasterVolume(0.3); sys.setVolume('engine', 2); sys.setVolume('atc', -1);
      sys.playUi('click'); sys.speak('Cessna one two three, contact tower.'); sys.stopSpeaking();
      sys.setMarker('outer'); sys.onTouchdown(-2); sys.apDisconnect(); sys.altitudeAlert();
      sys.setControls(defaultControlInputs()); sys.setSurface('grass'); sys.setListener([0, 0, 0]);
      sys.dispose();
    }).not.toThrow();
  });

  it('works in Node with the default factory and default speech (no globals)', async () => {
    const sys = new AudioSystem();
    await sys.resume();
    expect(sys.ready).toBe(false);
    expect(() => { sys.update(DT, makeAircraftState(), makeCamera(), makeWeather()); sys.speak('hello'); sys.dispose(); }).not.toThrow();
  });

  it('a throwing factory or rejected resume never escapes', async () => {
    const boom = new AudioSystem({ contextFactory: () => { throw new Error('boom'); }, speech: null });
    await expect(boom.resume()).resolves.toBeUndefined();
    expect(boom.ready).toBe(false);
    const { sys, mocks } = mockSystem({ rejectResume: true });
    await expect(sys.resume()).resolves.toBeUndefined();
    expect(sys.ready).toBe(false); // context exists but autoplay blocked
    const calls = () => mocks[0].allParams().reduce((n, p) => n + p.callCount, 0);
    const before = calls();
    sys.update(DT, makeAircraftState(), makeCamera(), makeWeather());
    expect(calls()).toBe(before); // cheap early-out while suspended
  });
});

describe('AudioSystem with a (mock) AudioContext', () => {
  it('resumes, plays a whole flight across camera modes with no direct .value writes or NaNs', async () => {
    const { sys, mocks } = mockSystem();
    await sys.resume();
    expect(sys.ready).toBe(true);
    const m = mocks[0];
    const modes = ['cockpit', 'chase', 'external-orbit', 'drone', 'tower', 'wing', 'flyby'] as const;
    let i = 0;
    sys.setControls({ starter: true, throttle: 0.1 });
    for (const s of flight()) {
      if (i === 60) sys.setControls({ starter: false, throttle: 0.3 });
      const cam = makeCamera(modes[Math.floor(i / 40) % modes.length], { dronePosNED: [200, 50, -20] });
      sys.update(DT, s, cam, makeWeather({ precipitationType: 'rain', precipitationRate: 5 }));
      m.advance(DT);
      i++;
    }
    expect(sys.engine?.phase).toBe('running');
    expect(m.directValueWrites).toEqual([]);
    for (const p of m.allParams()) for (const c of p.calls) if ('value' in c) expect(Number.isFinite(c.value)).toBe(true);
    sys.dispose();
    expect(m.state).toBe('closed');
  });

  it('setVolume / setMasterVolume / mute glide the bus gains', async () => {
    const { sys } = mockSystem();
    await sys.resume();
    const b = sys.audioGraph.buses!;
    sys.setVolume('engine', 0.25);
    expect((b.bus.engine.gain as unknown as MockAudioParam).last('setTargetAtTime')?.value).toBe(0.25);
    sys.setMasterVolume(0.7);
    expect((b.master.gain as unknown as MockAudioParam).target).toBe(0.7);
    sys.updateSnapshot(DT, {
      inputs: defaultControlInputs(), aircraft: makeAircraftState(), camera: makeCamera(), weather: makeWeather(), paused: true,
    } as unknown as SimSnapshot);
    expect((b.master.gain as unknown as MockAudioParam).target).toBe(0);
    sys.setMuted(false);
    expect((b.master.gain as unknown as MockAudioParam).target).toBe(0.7);
  });

  it('reacts to touchdown and autopilot-disconnect events', async () => {
    const events = new EventBus();
    const { sys, mocks } = mockSystem({ events });
    await sys.resume();
    const m = mocks[0];
    m.advance(0.05);
    const n0 = m.liveSources().length;
    events.emit('aircraft:touchdown', { verticalSpeedMs: -1.8, gForce: 1.4, lateralDriftMs: 0.3, centerlineOffsetM: 1, runway: '28R' });
    expect(m.liveSources().length).toBeGreaterThan(n0);
    const ap = (engaged: boolean) => ({ state: { engaged } as AutopilotState });
    events.emit('autopilot:changed', ap(true));
    const n1 = m.liveSources().length;
    events.emit('autopilot:changed', ap(false));
    expect(m.liveSources().length - n1).toBe(6); // two-tone × 3
    sys.dispose();
    events.emit('aircraft:touchdown', { verticalSpeedMs: -1, gForce: 1, lateralDriftMs: 0, centerlineOffsetM: null, runway: null });
  });

  it('skips a malformed frame without throwing, and keeps going on good frames', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { sys, mocks } = mockSystem();
      await sys.resume();
      const bad = { ...makeAircraftState(), engine: undefined } as unknown as AircraftState;
      expect(() => sys.update(DT, bad, makeCamera(), makeWeather())).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      const calls = () => mocks[0].allParams().reduce((n, p) => n + p.callCount, 0);
      const before = calls();
      const good = makeAircraftState({ engine: { ...makeAircraftState().engine, running: true, rpm: 2000, manifoldPressureInHg: 20 } });
      sys.update(DT, good, makeCamera(), makeWeather());
      expect(calls()).toBeGreaterThan(before); // still alive
      for (let i = 0; i < 40; i++) sys.update(DT, bad, makeCamera(), makeWeather());
      const after = calls();
      sys.update(DT, { ...good, aero: { ...good.aero, ias: 40 } }, makeCamera(), makeWeather());
      expect(calls()).toBe(after); // persistent errors disabled the voices
      expect(warn).toHaveBeenCalledTimes(1); // logged once, not per frame
    } finally {
      warn.mockRestore();
    }
  });

  it('rebuilds the voices when the context was closed (e.g. by the browser)', async () => {
    const { sys, mocks } = mockSystem();
    await sys.resume();
    const first = sys.engine;
    mocks[0].setState('closed');
    expect(sys.ready).toBe(false);
    await sys.resume();
    expect(mocks.length).toBe(2);
    expect(sys.ready).toBe(true);
    expect(sys.engine).not.toBe(first);
  });

  it('re-resumes on a later gesture after an iOS interruption', async () => {
    const { sys, mocks } = mockSystem();
    await sys.resume();
    mocks[0].setState('interrupted');
    expect(sys.ready).toBe(false);
    await sys.resume();
    expect(sys.ready).toBe(true);
    expect(mocks.length).toBe(1); // same context, no rebuild
  });

  it('squelch and engine duck around ATC speech', async () => {
    vi.useFakeTimers();
    try {
      const spoken: string[] = [];
      let endCb: (() => void) | null = null;
      const synth = {
        speak: (u: SpeechSynthesisUtterance) => { spoken.push(u.text); endCb = () => u.onend?.(new Event('end') as SpeechSynthesisEvent); },
        cancel: () => undefined,
        getVoices: () => [],
      };
      const mock = new MockAudioContext();
      const sys = new AudioSystem({
        contextFactory: () => asAudioContext(mock),
        speech: { synth, makeUtterance: (t) => ({ text: t }) as SpeechSynthesisUtterance, leadMs: 50 },
      });
      await sys.resume();
      mock.advance(0.05);
      const n0 = mock.liveSources().length;
      sys.speak('Cessna one two three, taxi to runway two eight right.', 'atc');
      expect(mock.liveSources().length - n0).toBe(2); // squelch click + static
      vi.advanceTimersByTime(50);
      expect(spoken.length).toBe(1);
      (endCb as (() => void) | null)?.();
      expect(mock.liveSources().length - n0).toBe(4); // + static tail + click
      sys.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** The view stage's engine level gain (bus.engine → LP → level gain). */
function engineLevel(sys: AudioSystem): MockAudioParam {
  const bus = sys.audioGraph.buses!.bus.engine as unknown as MockAudioNode;
  const lp = bus.outputs[bus.outputs.length - 1] as MockAudioNode;
  return (lp.outputs[0] as MockGainNode).gain;
}

describe('AudioSystem review fixes', () => {
  it('releases the engine duck when a transmission ends while the context is not running', async () => {
    vi.useFakeTimers();
    try {
      let endCb: (() => void) | null = null;
      const synth = {
        speak: (u: SpeechSynthesisUtterance) => { endCb = () => u.onend?.(new Event('end') as SpeechSynthesisEvent); },
        cancel: () => undefined,
        getVoices: () => [],
      };
      const mock = new MockAudioContext();
      const sys = new AudioSystem({
        contextFactory: () => asAudioContext(mock),
        speech: { synth, makeUtterance: (t) => ({ text: t }) as SpeechSynthesisUtterance, leadMs: 50 },
      });
      await sys.resume();
      sys.update(DT, makeAircraftState(), makeCamera('cockpit'), makeWeather());
      const level = engineLevel(sys);
      expect(level.target).toBeCloseTo(VIEW.cabinEngineLevel, 9);
      sys.speak('Cessna one two three, contact departure.', 'atc');
      expect(level.target).toBeCloseTo(VIEW.cabinEngineLevel * VIEW.duck, 9);
      vi.advanceTimersByTime(50);
      mock.setState('suspended'); // iOS interruption / audio focus loss mid-transmission
      (endCb as (() => void) | null)?.();
      expect(level.target).toBeCloseTo(VIEW.cabinEngineLevel, 9); // not stuck at −6 dB forever
      const live = mock.liveSources().length;
      sys.speak('Second.', 'atc');
      expect(mock.liveSources().length).toBe(live); // no squelch one-shots queued on a frozen clock
      sys.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('switching aircraft rebuilds the voices without leaving old stage filters on the buses', async () => {
    const { sys } = mockSystem();
    await sys.resume();
    const b = sys.audioGraph.buses!;
    const eng = b.bus.engine as unknown as MockAudioNode, env = b.bus.environment as unknown as MockAudioNode;
    for (let i = 0; i < 3; i++) sys.setAircraft(C172S);
    expect(eng.outputs.length).toBe(1);
    expect(env.outputs.length).toBe(1);
    expect(eng.inputs.length).toBe(1); // only the live engine synth feeds the bus
    sys.dispose();
  });

  it('a flight reset snaps the engine sound: no shutdown ticks or start cough for a teleport', async () => {
    const events = new EventBus();
    const { sys, mocks } = mockSystem({ events });
    await sys.resume();
    const m = mocks[0];
    const base = makeAircraftState();
    const running = makeAircraftState({ engine: { ...base.engine, running: true, rpm: 2300, manifoldPressureInHg: 22 } });
    const cold = makeAircraftState();
    const fly = (s: AircraftState, frames: number): Set<string> => {
      const seen = new Set<string>();
      for (let i = 0; i < frames; i++) { sys.update(DT, s, makeCamera(), makeWeather()); seen.add(sys.engine!.phase); m.advance(DT); }
      return seen;
    };
    const spawn = (engineRunning: boolean) => ({ spawn: { geo: base.geo, headingRad: 0, speedMs: 0, onGround: true, engineRunning } });
    expect([...fly(running, 10)]).toEqual(['running']);
    events.emit('flight:reset', spawn(false)); // → cold-and-dark ramp
    expect([...fly(cold, 10)]).toEqual(['off']);
    events.emit('flight:reset', spawn(true)); // → airborne with the engine running
    expect([...fly(running, 10)]).toEqual(['running']);
    sys.dispose();
  });

  it('stays dead after dispose: resume() does not build a new AudioContext and speech is silent', async () => {
    const spoken: string[] = [];
    const synth = { speak: (u: SpeechSynthesisUtterance) => { spoken.push(u.text); }, cancel: () => undefined, getVoices: () => [] };
    const mocks: MockAudioContext[] = [];
    const sys = new AudioSystem({
      contextFactory: () => { const m = new MockAudioContext(); mocks.push(m); return asAudioContext(m); },
      speech: { synth, makeUtterance: (t) => ({ text: t }) as SpeechSynthesisUtterance, leadMs: 0 },
    });
    await sys.resume();
    sys.dispose();
    expect(mocks[0].state).toBe('closed');
    await sys.resume(); // e.g. a stale gesture handler
    expect(mocks.length).toBe(1);
    expect(sys.ready).toBe(false);
    sys.speak('Cessna one two three, contact tower.');
    await new Promise((r) => setTimeout(r, 5));
    expect(spoken).toEqual([]);
  });

  it('UI sounds are not queued on a suspended context (they would all fire at once on resume)', async () => {
    const { sys, mocks } = mockSystem();
    await sys.resume();
    const m = mocks[0];
    m.setState('interrupted'); // iOS: another app took the audio session
    const live = m.liveSources().length;
    for (let i = 0; i < 5; i++) sys.playUi('click');
    expect(m.liveSources().length).toBe(live);
    m.setState('running');
    sys.playUi('click');
    expect(m.liveSources().length).toBeGreaterThan(live);
    sys.dispose();
  });

  it('a flight reset that changes the flap setting does not run the flap motor', async () => {
    const { sys, mocks } = mockSystem();
    await sys.resume();
    const base = makeAircraftState();
    const flaps = (deg: number) => makeAircraftState({ surfaces: { ...base.surfaces, flapDeg: deg } });
    for (let i = 0; i < 5; i++) { sys.update(DT, flaps(30), makeCamera(), makeWeather()); mocks[0].advance(DT); }
    sys.onFlightReset(false); // teleport to a clean-wing spawn
    for (let i = 0; i < 5; i++) {
      sys.update(DT, flaps(0), makeCamera(), makeWeather());
      expect(sys.environment!.flapMotorRunning).toBe(false);
      mocks[0].advance(DT);
    }
    sys.dispose();
  });
});
