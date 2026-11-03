/**
 * TEST ONLY: the whole UI (UiManager) over the fake DOM, with a fake simulator that runs the REAL
 * ActivityRunner and ProgressStore (src/activities). Spawns behave like the Simulator's: they emit
 * 'flight:reset' synchronously and leave the sim unpaused; `snapshot().paused` only follows
 * `setPaused` at the next frame, as the real host's cached snapshot does.
 *
 * Use with vitest fake timers including `performance` (UiManager reads performance.now()).
 */
import { vi } from 'vitest';
import { EventBus } from '../../core/events';
import { defaultControlInputs, type SimAction, type SimSnapshot, type Waypoint } from '../../core/types';
import { ActivityRunner, BUSH_TRIPS, ProgressStore, bushLegActivity, lessonById, tripById, type ActivityDef, type ActivityHost, type KeyValueStorage } from '../../activities';
import { C172S } from '../../fdm/aircraft/c172';
import { makeSampleSnapshot } from '../../instruments/testing/sampleSnapshot';
import type { UiHost } from '../UiHost';
import { UiManager } from '../UiManager';
import { installFakeDom, type FakeDomHandle, type FakeElement } from './fakeDom';

/** A lesson that completes after `holdS` seconds of flight (step 1) and, with two steps, another `holdS` (step 2). */
export function quickLesson(id = 'lesson-basic-flight', holdS = 1, steps = 1): ActivityDef {
  const real = lessonById(id);
  return {
    id, kind: 'lesson', title: real?.title ?? 'Quick lesson', description: 'test', aircraft: 'c172',
    setup: { spawn: 'air', lat: 37.5, lon: -122.6, altFt: 3000, headingDeg: 90, iasKt: 100, weather: 'clear', time: 'morning' },
    steps: Array.from({ length: steps }, (_, i) => ({
      id: `s${i}`, title: `Step ${i + 1} title`,
      instruction: { text: `Instruction ${i + 1}: hold it.` },
      objectives: [{ type: 'hold' as const, label: `Hold ${i + 1}`, forS: holdS, all: [{ c: 'altitudeBand' as const, minFt: 0 }] }],
      success: { text: `Step ${i + 1} done.` },
    })),
    debrief: { pass: { text: 'Well flown, that is the end of the lesson.' }, fail: { text: 'Let us try that again.' } },
  };
}

/** A bush leg of the real trip that completes after `holdS` seconds (the real one needs a landing). */
export function quickLeg(legIndex: number, holdS = 1): ActivityDef {
  const trip = BUSH_TRIPS[0];
  const real = bushLegActivity(trip, legIndex);
  return { ...real, steps: [{ id: 'fly', title: 'Fly the leg', instruction: { text: `Leg ${legIndex + 1}: off you go.` }, objectives: [{ type: 'hold', label: 'Fly', forS: holdS, all: [{ c: 'altitudeBand', minFt: 0 }] }] }] };
}

class MemStorage implements KeyValueStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.m.set(k, v); }
  removeItem(k: string): void { this.m.delete(k); }
}

export class FakeSim {
  readonly events = new EventBus();
  readonly progress = new ProgressStore(new MemStorage());
  readonly runner: ActivityRunner;
  readonly snap: SimSnapshot = makeSampleSnapshot();
  paused = true;
  inFlight = false;
  route: Waypoint[] | null = null;
  /** the next spawn rejects with this */
  spawnError: Error | null = null;
  spawns = 0;
  dispatched: SimAction[] = [];
  /** lessons / legs the host starts instead of the real (long) ones */
  lessons = new Map<string, ActivityDef>();
  legs = new Map<number, ActivityDef>();

  constructor() {
    const host: ActivityHost = {
      spawnAtRunway: () => this.spawn(),
      spawnInAir: () => this.spawn(),
      setWeatherPreset: () => undefined,
      setTimePreset: () => undefined,
      loadRoute: (w) => { this.route = [...w]; },
      clearRoute: () => { this.route = null; },
    };
    this.runner = new ActivityRunner({ host, events: this.events, progress: this.progress });
  }

  async spawn(): Promise<void> {
    await Promise.resolve();
    this.spawns++;
    if (this.spawnError) { const e = this.spawnError; this.spawnError = null; throw e; }
    // Simulator.beginFlight: unpaused, in flight, then 'flight:reset'
    this.inFlight = true;
    this.paused = false;
    this.events.emit('flight:reset', { spawn: { geo: { lat: 37.5, lon: -122.6, alt: 900 }, headingRad: 0, speedMs: 50, onGround: false, engineRunning: true } });
  }

  /** One simulator frame: the cached snapshot follows the live pause state; the runner steps while flying. */
  step(dtS: number): void {
    this.snap.paused = this.paused || !this.inFlight;
    if (!this.snap.paused) this.runner.update(dtS, this.snap.aircraft, defaultControlInputs());
  }

  readonly host: UiHost = (() => { const sim = () => this; return {
    events: this.events,
    nav: {
      loadRegion: async () => undefined, getAirport: () => undefined, nearestAirports: () => [], nearestNavaids: () => [],
      searchAirports: () => [], findNavaidByFrequency: () => undefined, findIlsByFrequency: () => undefined,
    },
    snapshot: () => this.snap,
    aircraftList: () => [C172S],
    currentAircraft: () => C172S,
    dispatch: (a) => {
      this.dispatched.push(a);
      if (a === 'resetFlight') void this.spawn();
    },
    spawn: () => this.spawn(),
    setWeatherPreset: () => undefined,
    setCustomWeather: () => undefined,
    requestLiveWeather: async () => false,
    setTime: () => undefined,
    setTimeScale: () => undefined,
    setPaused: (p) => { this.paused = p; },
    setCamera: () => undefined,
    setAssists: () => undefined,
    setGraphics: () => undefined,
    setAudio: () => undefined,
    setUnits: () => undefined,
    bindings: () => [],
    rebind: async () => null,
    resetBindings: () => undefined,
    dataCredits: () => [],
    captureInput: () => undefined,
    addWaypoint: () => undefined,
    clearPlan: () => { this.route = null; },
    startLesson: async (id) => {
      const def = this.lessons.get(id) ?? lessonById(id);
      if (!def) throw new Error(`unknown lesson ${id}`);
      await this.runner.start(def);
    },
    startBushLeg: async (tripId, i) => {
      const trip = tripById(tripId);
      if (!trip) throw new Error(`unknown trip ${tripId}`);
      await this.runner.start(this.legs.get(i) ?? bushLegActivity(trip, i));
    },
    abortActivity: () => this.runner.abort(),
    restartActivity: () => this.runner.restart(),
    restartActivityStep: () => this.runner.restartStep(),
    // getters: this object is built before the constructor assigns the runner
    get activityRunner() { return sim().runner; },
    get activityProgress() { return sim().progress; },
  }; })();
}

export interface Harness {
  dom: FakeDomHandle;
  sim: FakeSim;
  ui: UiManager;
  root: FakeElement;
  /** advance the clock by `ms` in frames of `stepMs` (timers, promises, sim, UI) */
  run(ms: number, stepMs?: number): Promise<void>;
  /** the first element matching `sel` under the UI root */
  q(sel: string): FakeElement | null;
  dispose(): void;
}

export async function makeHarness(opts: { width?: number; height?: number } = {}): Promise<Harness> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  const dom = installFakeDom(opts);
  const sim = new FakeSim();
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const ui = new UiManager(container as unknown as HTMLElement, sim.host);
  const root = ui.root as unknown as FakeElement;
  const run = async (ms: number, stepMs = 50) => {
    for (let t = 0; t < ms; t += stepMs) {
      await vi.advanceTimersByTimeAsync(stepMs);
      sim.step(stepMs / 1000);
      ui.update(sim.snap, stepMs / 1000);
    }
  };
  // past the boot splash, like a first click
  ui.show('main');
  await run(100);
  return {
    dom, sim, ui, root, run,
    q: (sel) => root.querySelector(sel),
    dispose: () => { ui.dispose(); sim.runner.dispose(); dom.uninstall(); vi.useRealTimers(); },
  };
}
