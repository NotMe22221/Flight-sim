import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/events';
import type { AircraftState, ControlInputs, SpawnState } from '../core/types';
import { FT, KT } from '../core/units';
import { ActivityRunner, type ProgressItem } from './ActivityRunner';
import type { ActivityDef, ActivityHost } from './activityTypes';
import { FakeHost, flyState, inputsWith, recordActivityEvents, type FlyParams } from './activityTestKit';
import { ProgressStore } from './progressStore';

const SIMPLE: ActivityDef = {
  id: 'test-simple', kind: 'lesson', title: 'Simple', description: 'Two steps.',
  setup: { spawn: 'air', lat: 37.5, lon: -122.6, altFt: 3000, headingDeg: 90, iasKt: 100, weather: 'clear', time: 'noon' },
  steps: [
    {
      id: 'a', title: 'Hold', instruction: { text: 'Hold 3,000 ft', speech: 'Hold three thousand feet' },
      objectives: [{ type: 'hold', label: 'Hold 3,000 ft for 5 s', forS: 5, all: [{ c: 'altitude', ft: 3000, tolFt: 100 }] }],
      hints: [{ text: 'Coach 1', speech: 'Coach one' }],
      success: { text: 'Done A' },
    },
    {
      id: 'b', title: 'Climb', instruction: { text: 'Climb to 3,500 ft' },
      objectives: [
        { type: 'reach', label: 'Reach 3,500 ft', all: [{ c: 'altitude', ft: 3500, tolFt: 50 }], progress: { metric: 'altitudeFt', to: 3500 }, doneLine: { text: 'Level at 3,500' } },
        { type: 'reach', label: 'Flaps 10 (optional)', all: [{ c: 'flaps', minDeg: 10 }], optional: true },
      ],
      cues: [{ when: [{ c: 'altitudeBand', minFt: 3250 }], line: { text: 'Halfway' } }],
    },
  ],
  debrief: { pass: { text: 'Well done' }, fail: { text: 'Try again' } },
};

function setup(opts: { host?: ActivityHost; progress?: ProgressStore | null; speakHints?: boolean } = {}) {
  const events = new EventBus();
  const host = (opts.host as FakeHost | undefined) ?? new FakeHost();
  const runner = new ActivityRunner({ host, events, progress: opts.progress ?? null, speakHints: opts.speakHints });
  const rec = recordActivityEvents(events);
  /** instruction texts with the runner time they were said */
  const said: { t: number; text: string }[] = [];
  events.on('activity:instruction', (e) => said.push({ t: runner.elapsedS, text: e.text }));
  const inputs = inputsWith();
  const frames = (seconds: number, p: FlyParams | ((t: number) => FlyParams), dt = 0.1, i: ControlInputs = inputs) => {
    for (let t = 0; t < seconds - 1e-9; t += dt) runner.update(dt, flyState(typeof p === 'function' ? p(t) : p), i);
  };
  return { events, host: host as FakeHost, runner, rec, said, frames, inputs };
}

const spawnAt = (lat: number, lon: number): SpawnState => ({ geo: { lat, lon, alt: 900 }, headingRad: 0, speedMs: 50, onGround: false, engineRunning: true });

describe('ActivityRunner: start and event sequence', () => {
  it('sets the flight up in order and emits started, the first instruction and progress exactly once', async () => {
    const { runner, rec, host } = setup();
    await runner.start(SIMPLE);
    expect(host.calls).toEqual(['weather clear', 'spawnInAir', 'time noon']);
    expect(host.lastAirSpawn).toMatchObject({ lat: 37.5, lon: -122.6, headingDeg: 90 });
    expect(host.lastAirSpawn!.altM).toBeCloseTo(3000 * FT, 9);
    expect(host.lastAirSpawn!.iasMs).toBeCloseTo(100 * KT, 9);
    expect(rec.log.map((e) => e.name)).toEqual(['activity:started', 'activity:instruction', 'activity:progress']);
    expect(rec.of('activity:started')).toEqual([{ id: 'test-simple', title: 'Simple', kind: 'lesson' }]);
    expect(rec.of('activity:instruction')[0]).toEqual({ text: 'Hold 3,000 ft', speech: 'Hold three thousand feet', important: true });
    expect(host.spoken).toEqual(['Hold three thousand feet']);
    expect(runner.phase).toBe('running');
    expect(runner.step?.id).toBe('a');
  });

  it('runs both steps: success line, next instruction, cue and done line once each, then finished once', async () => {
    const { runner, rec, frames, said } = setup();
    await runner.start(SIMPLE);
    frames(5.2, { altFt: 3000 }); // hold: needs 5 s
    expect(runner.step?.id).toBe('b');
    frames(10, (t) => ({ altFt: 3000 + 30 * t })); // climbing (headway: no nagging)
    frames(5, (t) => ({ altFt: 3290 + (t % 1 < 0.5 ? 10 : -60) })); // in and out of the cue band: said once
    frames(10, (t) => ({ altFt: Math.min(3300 + 30 * t, 3500) }));
    expect(runner.phase).toBe('finished');
    // the optional objective is coached once no required objective needs a correction
    expect(said.map((x) => x.text)).toEqual(['Hold 3,000 ft', 'Done A', 'Climb to 3,500 ft', 'Flaps down to 10°', 'Halfway', 'Level at 3,500', 'Well done']);
    expect(rec.of('activity:started').length).toBe(1);
    const fin = rec.of('activity:finished');
    expect(fin.length).toBe(1);
    expect(fin[0]).toMatchObject({ id: 'test-simple', success: true });
    expect(fin[0].summary).toContain('Simple complete');
    expect(fin[0].summary).toContain('Well done');
    // progress only on changes: first step, second step, end (not per frame)
    const prog = rec.of('activity:progress');
    expect(prog.length).toBe(3);
    expect(prog.map((p) => p.step)).toEqual([0, 1, 1]);
    const last = prog[2].objectives as ProgressItem[];
    expect(last.map((o) => [o.text, o.status, o.step, o.optional])).toEqual([
      ['Hold 3,000 ft for 5 s', 'done', 0, false], ['Reach 3,500 ft', 'done', 1, false], ['Flaps 10 (optional)', 'failed', 1, true],
    ]);
    const first = prog[0].objectives as ProgressItem[];
    expect(first.map((o) => o.status)).toEqual(['active', 'pending', 'pending']);
    const r = runner.result!;
    expect(r.success).toBe(true);
    expect(r.steps[1].objectives[1]).toMatchObject({ state: 'failed', optional: true, note: 'Missed' });
    expect(r.steps.every((s) => s.completed)).toBe(true);
  });

  it('an objective status change between step transitions emits one progress event', async () => {
    const def: ActivityDef = { ...SIMPLE, steps: [{ ...SIMPLE.steps[1], objectives: [SIMPLE.steps[1].objectives[0], { type: 'reach', label: 'Flaps 10', all: [{ c: 'flaps', minDeg: 10 }] }] }] };
    const { runner, rec, frames } = setup();
    await runner.start(def);
    frames(10, { altFt: 3500 });
    expect(rec.of('activity:progress').length).toBe(2); // start + 'Reach 3,500 ft' done
    frames(10, { altFt: 3500 });
    expect(rec.of('activity:progress').length).toBe(2);
    frames(2, { altFt: 3500, flapDeg: 10 });
    expect(runner.result?.success).toBe(true);
    expect(rec.of('activity:progress').length).toBe(3);
  });

  it('the route is loaded after the spawn and cleared at the end', async () => {
    const def: ActivityDef = { ...SIMPLE, setup: { ...SIMPLE.setup, route: [{ id: 'A', type: 'user', position: { lat: 37, lon: -122, alt: 1000 } }] } };
    const { runner, host } = setup();
    await runner.start(def);
    expect(host.calls).toEqual(['weather clear', 'spawnInAir', 'time noon', 'route 1']);
    runner.abort();
    expect(host.calls[host.calls.length - 1]).toBe('clearRoute');
  });
});

describe('ActivityRunner: hints', () => {
  it('coaching first, then live hints; at most one every 8 s and the same one not within 20 s', async () => {
    const { runner, said, host } = setup();
    await runner.start(SIMPLE);
    const n0 = said.length;
    host.spoken.length = 0;
    expect(runner.liveHint).toBeNull();
    runner.update(0.1, flyState({ altFt: 3400 }), inputsWith());
    expect(runner.liveHint?.text).toBe('Too high: descend to 3,000 ft');
    let t = 0.1;
    while (t < 120) { runner.update(0.1, flyState({ altFt: 3400 }), inputsWith()); t += 0.1; }
    const hints = said.slice(n0);
    expect(hints[0].text).toBe('Coach 1');
    expect(hints[0].t).toBeGreaterThanOrEqual(4);
    expect(hints[0].t).toBeLessThan(4.5);
    expect(hints.slice(1).every((h) => h.text === 'Too high: descend to 3,000 ft')).toBe(true);
    for (let i = 1; i < hints.length; i++) {
      expect(hints[i].t - hints[i - 1].t).toBeGreaterThanOrEqual(8 - 1e-6);
      if (i > 1) expect(hints[i].t - hints[i - 1].t).toBeGreaterThanOrEqual(20 - 1e-6);
    }
    expect(hints.length).toBeGreaterThanOrEqual(5);
    expect(hints.length).toBeLessThanOrEqual(7);
    expect(host.spoken[0]).toBe('Coach one');
    expect(host.spoken[1]).toBe('Too high. Descend to three thousand feet');
  });

  it('back on target clears the live hint and restarts the 4 s delay; speakHints:false keeps hints silent', async () => {
    const { runner, said, host } = setup({ speakHints: false });
    await runner.start(SIMPLE);
    const n0 = said.length, s0 = host.spoken.length;
    const fly = (s: number, altFt: number) => { for (let t = 0; t < s - 1e-9; t += 0.1) runner.update(0.1, flyState({ altFt }), inputsWith()); };
    fly(3, 3400);
    fly(1, 3000);
    expect(runner.liveHint).toBeNull();
    fly(3, 3400);
    expect(said.length).toBe(n0); // never 4 s continuously off target
    fly(1.5, 3400);
    expect(said.length).toBe(n0 + 1);
    expect(host.spoken.length).toBe(s0);
  });

  it('quiet steps never coach', async () => {
    const def: ActivityDef = { ...SIMPLE, steps: [{ ...SIMPLE.steps[0], quiet: true }] };
    const { runner, said, frames } = setup();
    await runner.start(def);
    frames(60, { altFt: 3600 });
    expect(said.length).toBe(1);
    expect(runner.liveHint).toBeNull();
  });
});

describe('ActivityRunner: lifecycle edges', () => {
  it('ignores non-positive, NaN and infinite dt (time only advances through update)', async () => {
    const { runner } = setup();
    await runner.start(SIMPLE);
    for (const dt of [0, -1, NaN, Infinity, -Infinity]) runner.update(dt, flyState({ altFt: 3000 }), inputsWith());
    expect(runner.elapsedS).toBe(0);
    expect(runner.objectives[0].progress).toBe(0);
    runner.update(1, flyState({ altFt: 3000 }), inputsWith());
    expect(runner.elapsedS).toBe(1);
    expect(runner.objectives[0].progress).toBeCloseTo(0.2, 9);
  });

  it('a crash finishes once with the reason; later crashes, landings and updates are ignored', async () => {
    const store = new ProgressStore(null);
    const { runner, rec, events, frames } = setup({ progress: store });
    await runner.start(SIMPLE);
    frames(2, { altFt: 3000 });
    events.emit('aircraft:crash', { reason: 'stall spin' });
    events.emit('aircraft:crash', { reason: 'again' });
    events.emit('landing:scored', { score: 9000, details: {} });
    frames(10, { altFt: 3000 });
    expect(rec.of('activity:finished')).toEqual([{ id: 'test-simple', success: false, score: runner.result!.score, summary: runner.result!.summary }]);
    expect(runner.result).toMatchObject({ success: false, grade: 'Incomplete', reason: 'Crash: stall spin', landingScore: null });
    expect(runner.result!.durationS).toBeCloseTo(2, 6);
    expect(runner.result!.summary).toBe('Simple not completed: Crash: stall spin. Try again');
    expect(store.lesson('test-simple')).toMatchObject({ completed: false, attempts: 1 });
  });

  it("flight:reset from the runner's own spawn is ignored; near the start it restarts, elsewhere it ends", async () => {
    const events = new EventBus();
    const host = new FakeHost(() => { events.emit('flight:reset', { spawn: spawnAt(37.5, -122.6) }); });
    const runner = new ActivityRunner({ host, events });
    const rec = recordActivityEvents(events);
    await runner.start(SIMPLE);
    expect(rec.of('activity:instruction').length).toBe(1);
    for (let t = 0; t < 8; t += 0.1) runner.update(0.1, flyState({ altFt: 3000 }), inputsWith());
    expect(runner.step?.id).toBe('b');
    events.emit('flight:reset', { spawn: spawnAt(37.51, -122.61) });
    expect(runner.running).toBe(true);
    expect(runner.step?.id).toBe('a');
    expect(runner.elapsedS).toBe(0);
    expect(runner.objectives[0].state).toBe('pending');
    expect(rec.of('activity:instruction').filter((x) => x.text === 'Hold 3,000 ft').length).toBe(2);
    expect(rec.of('activity:finished').length).toBe(0);
    events.emit('flight:reset', { spawn: spawnAt(40, -120) });
    expect(rec.of('activity:finished')).toMatchObject([{ success: false }]);
    expect(runner.result?.reason).toBe('Flight changed');
  });

  it('abort while the spawn is pending cancels silently; abort while running finishes once', async () => {
    let release: () => void = () => {};
    const events = new EventBus();
    const host = new FakeHost(() => new Promise<void>((r) => { release = r; }));
    const runner = new ActivityRunner({ host, events });
    const rec = recordActivityEvents(events);
    const p = runner.start(SIMPLE);
    expect(runner.phase).toBe('starting');
    runner.abort();
    release();
    await p;
    expect(runner.phase).toBe('idle');
    expect(rec.log.length).toBe(0);
    expect(host.calls).not.toContain('time noon');

    const { runner: r2, rec: rec2 } = setup();
    await r2.start(SIMPLE);
    r2.abort();
    r2.abort();
    expect(rec2.of('activity:finished')).toMatchObject([{ success: false }]);
    expect(r2.result?.reason).toBe('Aborted');
  });

  it('restartStep resets the current objectives and repeats only its instruction', async () => {
    const { runner, rec, frames } = setup();
    await runner.start(SIMPLE);
    frames(3, { altFt: 3000 });
    expect(runner.objectives[0].progress).toBeCloseTo(0.6, 6);
    runner.restartStep();
    expect(runner.objectives[0].progress).toBe(0);
    expect(rec.of('activity:instruction').map((x) => x.text)).toEqual(['Hold 3,000 ft', 'Hold 3,000 ft']);
    frames(5.2, { altFt: 3000 });
    expect(runner.step?.id).toBe('b');
  });

  it('starting another activity finishes the running one first', async () => {
    const { runner, rec } = setup();
    await runner.start(SIMPLE);
    await runner.start({ ...SIMPLE, id: 'second', title: 'Second' });
    expect(rec.of('activity:finished')).toMatchObject([{ id: 'test-simple', success: false }]);
    expect(rec.of('activity:started').map((s) => s.id)).toEqual(['test-simple', 'second']);
    expect(runner.def?.id).toBe('second');
    expect(runner.running).toBe(true);
  });

  it('a failing spawn rejects, leaves the runner idle and emits nothing', async () => {
    const events = new EventBus();
    const runner = new ActivityRunner({ host: new FakeHost(() => Promise.reject(new Error('no such airport'))), events });
    const rec = recordActivityEvents(events);
    await expect(runner.start(SIMPLE)).rejects.toThrow('no such airport');
    expect(runner.phase).toBe('idle');
    expect(rec.log.length).toBe(0);
    runner.update(0.1, flyState(), inputsWith());
    expect(runner.elapsedS).toBe(0);
  });

  it('a score below the pass mark is not a pass', async () => {
    const def: ActivityDef = { ...SIMPLE, passScore: 99, steps: [{ ...SIMPLE.steps[0], objectives: [{ type: 'hold', label: 'Hold', forS: 5, all: [{ c: 'altitude', ft: 3000, tolFt: 100 }] }] }] };
    const { runner, frames } = setup();
    await runner.start(def);
    frames(10, { altFt: 3090 }); // inside the band but near its edge
    expect(runner.result?.success).toBe(false);
    expect(runner.result?.reason).toMatch(/^Score \d+ is below the pass mark of 99$/);
  });

  it('landings scored before the landing step are ignored; the step after takes the next one', async () => {
    const def: ActivityDef = {
      ...SIMPLE,
      steps: [SIMPLE.steps[0], { id: 'land', title: 'Land', instruction: { text: 'Land' }, objectives: [{ type: 'landing', label: 'Land', minScore: 5000 }] }],
    };
    const { runner, events, frames } = setup();
    await runner.start(def);
    events.emit('landing:scored', { score: 9000, details: { runway: 'KHAF 30', grade: 'Butter' } });
    frames(6, { altFt: 3000 });
    expect(runner.step?.id).toBe('land');
    frames(1, { altFt: 3000 });
    expect(runner.running).toBe(true);
    events.emit('landing:scored', { score: 6200, details: { runway: 'KHAF 30', grade: 'Good', touchdownFromThresholdM: 400 } });
    frames(0.1, { altFt: 3000 });
    expect(runner.result).toMatchObject({ success: true, landingScore: 6200 });
  });

  it('records fuel at the end and progress for lessons; dispose unsubscribes', async () => {
    const store = new ProgressStore(null);
    const { runner, events } = setup({ progress: store });
    await runner.start(SIMPLE);
    const s: AircraftState = flyState({ altFt: 3000 });
    s.fuelKg = [40, 35.5];
    for (let t = 0; t < 6; t += 0.1) runner.update(0.1, s, inputsWith());
    const s2 = flyState({ altFt: 3500 });
    s2.fuelKg = [39, 35];
    for (let t = 0; t < 2; t += 0.1) runner.update(0.1, s2, inputsWith());
    expect(runner.result?.success).toBe(true);
    expect(runner.result?.fuelKg).toBeCloseTo(74, 9);
    expect(store.lesson('test-simple')).toMatchObject({ completed: true, attempts: 1 });
    runner.dispose();
    await runner.start(SIMPLE);
    events.emit('aircraft:crash', { reason: 'x' });
    expect(runner.running).toBe(true);
  });
});
