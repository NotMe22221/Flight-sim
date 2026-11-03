import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/events';
import type { Airport } from '../core/types';
import { DEG, FT, KT, NM } from '../core/units';
import { destinationPoint, greatCircleDistance, initialBearingDeg } from '../geo/wgs84';
import { magneticDeclinationAtYearDeg } from '../geo/magvar';
import { ActivityRunner } from './ActivityRunner';
import type { ActivityDef } from './activityTypes';
import { FakeHost, ScriptedAircraft, compactAirport, dataAirport, flyState, inputsWith, recordActivityEvents } from './activityTestKit';
import { BASIC_FLIGHT, KHAF_30, KHAF_30_TDZ, KHAF_POS, KSFO_28R, LANDING, LESSONS, TAKEOFF, lessonById } from './lessons';
import { compileCondition, makeObjectiveContext, runwayEndRef, type RunwaySpec } from './objectives';
import { ProgressStore } from './progressStore';
import { aimAlongM, relativeToRunway } from './runwayFrame';
import { TouchdownDetector } from './TouchdownDetector';

const D2R = Math.PI / 180;
const DT = 0.1;
type Policy = (a: ScriptedAircraft, step: string, t: number) => void;

const detectors = new WeakMap<ActivityRunner, TouchdownDetector>();

/** Start a lesson on a fresh bus/host/runner (with a TouchdownDetector on the bus when `airports` are given). */
async function lesson(def: ActivityDef, ac: ScriptedAircraft, airports?: Airport[]) {
  const events = new EventBus();
  const host = new FakeHost();
  const store = new ProgressStore(null);
  const runner = new ActivityRunner({ host, events, progress: store });
  const rec = recordActivityEvents(events);
  await runner.start(def);
  if (airports) {
    const td = new TouchdownDetector(events, { airports: () => airports });
    td.reset(ac.onGround);
    detectors.set(runner, td);
  }
  return { events, host, store, runner, rec };
}

/** Advance the scripted aircraft, the lesson's TouchdownDetector (if any) and the runner for up to `seconds`. */
function runnerFly(runner: ActivityRunner, ac: ScriptedAircraft, policy: Policy, seconds: number, stop?: () => boolean): number {
  const td = detectors.get(runner);
  let t = 0;
  while (runner.running && t < seconds - 1e-9 && !(stop && stop())) {
    policy(ac, runner.step?.id ?? '', t);
    ac.step(DT);
    const s = ac.state();
    td?.step(DT, s);
    runner.update(DT, s, ac.inputs);
    t += DT;
  }
  return t;
}

const texts = (rec: ReturnType<typeof recordActivityEvents>) => rec.of('activity:instruction').map((x) => x.text);

describe('lesson runway data matches public/data', () => {
  const check = (spec: RunwaySpec) => {
    const c = compactAirport(spec.icao)!;
    expect(c).toBeDefined();
    const rw = (c.r ?? []).find((r) => r.le[0] === spec.ident || r.he[0] === spec.ident)!;
    expect(rw, `${spec.icao} ${spec.ident}`).toBeDefined();
    const end = rw.le[0] === spec.ident ? rw.le : rw.he;
    expect([end[1], end[2], end[3], end[4], end[5] ?? 0]).toEqual([spec.lat, spec.lon, spec.elevM, spec.headingDeg, spec.displacedM]);
    expect([rw.l, rw.w]).toEqual([spec.lengthM, spec.widthM]);
  };
  it('KSFO 28R and KHAF 30', () => { check(KSFO_28R); check(KHAF_30); });
  it('Half Moon Bay reference point', () => {
    const c = compactAirport('KHAF')!;
    expect([c.la, c.lo]).toEqual([KHAF_POS.lat, KHAF_POS.lon]);
  });
  it('the KHAF 30 touchdown zone starts at the displaced threshold and contains the aim point', () => {
    expect(KHAF_30_TDZ.fromM).toBe(233);
    expect(aimAlongM(KHAF_30)).toBeGreaterThan(KHAF_30_TDZ.fromM);
    expect(aimAlongM(KHAF_30)).toBeLessThan(KHAF_30_TDZ.toM);
  });
});

describe('lesson set-ups', () => {
  it('basic flight: air start 8 nm west of KHAF at 3,000 ft, 100 KIAS, wings level, heading 090 on the indicator', () => {
    const s = BASIC_FLIGHT.setup;
    if (s.spawn !== 'air') throw new Error('air start expected');
    const fromHaf = { lat: KHAF_POS.lat, lon: KHAF_POS.lon, alt: 0 };
    expect(greatCircleDistance(fromHaf, { lat: s.lat, lon: s.lon, alt: 0 }) / NM).toBeCloseTo(8, 2);
    expect(initialBearingDeg(fromHaf, { lat: s.lat, lon: s.lon, alt: 0 })).toBeCloseTo(270, 0);
    expect([s.altFt, s.iasKt, s.gammaDeg, s.flapsIndex]).toEqual([3000, 100, 0, 0]);
    const decl = magneticDeclinationAtYearDeg(s.lat, s.lon, 914, 2026.5);
    expect(decl).toBeGreaterThan(10); // ~13° E in the Bay Area
    expect(s.headingDeg - decl).toBeCloseTo(90, 6);
  });
  it('takeoff: on KSFO 28R with the parking brake set; a reset at the airport restarts the lesson', () => {
    expect(TAKEOFF.setup).toMatchObject({ spawn: 'runway', icao: 'KSFO', runway: '28R', parkingBrake: true });
    const s = TAKEOFF.setup;
    if (s.spawn !== 'runway' || !s.anchor) throw new Error('runway start with an anchor expected');
    const c = compactAirport('KSFO')!;
    expect(greatCircleDistance({ lat: c.la, lon: c.lo, alt: 0 }, { lat: s.anchor.lat, lon: s.anchor.lon, alt: 0 })).toBeLessThan(5000);
  });
  it('landing: a 3 nm final to KHAF 30 on the 3° path to the aim point, 65 KIAS, flaps 20°', () => {
    const s = LANDING.setup;
    if (s.spawn !== 'air') throw new Error('air start expected');
    const rel = relativeToRunway({ lat: s.lat, lon: s.lon, alt: 0 }, runwayEndRef(KHAF_30));
    expect(-rel.alongM / NM).toBeCloseTo(3, 2);
    expect(Math.abs(rel.crossM)).toBeLessThan(5); // geodesic spawn vs the flat runway frame: ~2 m at 3 nm
    const pathFt = (KHAF_30.elevM + (3 * NM + aimAlongM(KHAF_30)) * Math.tan(3 * D2R)) / FT;
    expect(s.altFt).toBeCloseTo(pathFt, 6);
    expect(s.altFt).toBeGreaterThan(1000);
    expect(s.altFt).toBeLessThan(1100);
    expect([s.headingDeg, s.iasKt, s.flapsIndex, s.gammaDeg]).toEqual([317, 65, 2, -3]);
  });
});

describe('instructor lines', () => {
  it('every speech line is spelled out for text-to-speech (no digits), every step has an instruction', () => {
    for (const def of LESSONS) {
      expect(lessonById(def.id)).toBe(def);
      const lines = [def.debrief?.pass, def.debrief?.fail, ...def.steps.flatMap((s) => [s.instruction, s.success, ...(s.hints ?? []), ...(s.cues ?? []).map((c) => c.line), ...s.objectives.map((o) => o.doneLine)])];
      for (const l of lines) if (l?.speech) expect(l.speech, l.speech).not.toMatch(/\d/);
      for (const st of def.steps) {
        expect(st.instruction.text.length).toBeGreaterThan(10);
        expect(st.instruction.speech, `${def.id}/${st.id}`).toBeDefined();
        expect(st.objectives.length).toBeGreaterThan(0);
      }
    }
  });
  it('compiled hints speak numbers as words', () => {
    const ctx = makeObjectiveContext(flyState({ flapDeg: 0 }), inputsWith());
    const c = compileCondition({ c: 'flaps', minDeg: 30 });
    c.test(ctx);
    expect(c.hint?.speech).toBe('Set flaps thirty.');
    const up = compileCondition({ c: 'flaps', maxDeg: 10 });
    ctx.state = flyState({ flapDeg: 20 });
    up.test(ctx);
    expect(up.hint?.speech).toBe('Raise the flaps to ten.');
  });
});

// ───────────────────────────── Basic flight controls ─────────────────────────────

function basicAircraft(): ScriptedAircraft {
  const s = BASIC_FLIGHT.setup;
  if (s.spawn !== 'air') throw new Error('air start expected');
  const decl = magneticDeclinationAtYearDeg(s.lat, s.lon, 914, 2026.5);
  return new ScriptedAircraft({ lat: s.lat, lon: s.lon, altFt: s.altFt, hdgTrue: s.headingDeg, decl, iasKt: s.iasKt });
}

const basicPolicy: Policy = (a, step) => {
  switch (step) {
    case 'level': a.steer({ altFt: 3000, magHdgDeg: 90 }); break;
    case 'climb': a.steer({ altFt: 3500, magHdgDeg: 90, maxVsFpm: 600 }); break;
    case 'levelOff': a.steer({ altFt: 3500, magHdgDeg: 90 }); break;
    case 'turnRight': a.steer({ altFt: 3500, magHdgDeg: 180 }); break;
    case 'turnLeft': a.steer({ altFt: 3500, magHdgDeg: 90 }); break;
    case 'descend': a.steer({ altFt: 3000, magHdgDeg: 90, maxVsFpm: 500 }); break;
    case 'trim': a.steer({ altFt: 3000, magHdgDeg: 90 }); break;
  }
};

describe('lesson: basic flight controls', () => {
  it('flown through: every step in order, each instruction once, a good score and the debrief', async () => {
    const ac = basicAircraft();
    const { runner, rec, host, store } = await lesson(BASIC_FLIGHT, ac);
    const steps: string[] = [];
    let t = 0;
    while (runner.running && t < 1200) {
      const id = runner.step?.id ?? '';
      if (steps[steps.length - 1] !== id) steps.push(id);
      t += runnerFly(runner, ac, basicPolicy, DT);
    }
    expect(runner.phase).toBe('finished');
    expect(steps).toEqual(BASIC_FLIGHT.steps.map((s) => s.id));
    expect(t).toBeLessThan(400);
    const r = runner.result!;
    expect(r.success).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.steps.every((s) => s.completed)).toBe(true);
    for (const st of BASIC_FLIGHT.steps) expect(texts(rec).filter((x) => x === st.instruction.text).length, st.id).toBe(1);
    expect(texts(rec)).toContain(BASIC_FLIGHT.debrief!.pass.text);
    expect(rec.of('activity:finished')).toEqual([{ id: BASIC_FLIGHT.id, success: true, score: r.score, summary: r.summary }]);
    expect(host.lastAirSpawn).toMatchObject({ altM: 3000 * FT, iasMs: 100 * KT, opts: { flapsIndex: 0, gammaRad: 0 } });
    expect(host.calls).toEqual(['weather clear', 'spawnInAir', 'time morning']);
    expect(host.spoken[0]).toBe(BASIC_FLIGHT.steps[0].instruction.speech);
    expect(store.lesson(BASIC_FLIGHT.id)).toMatchObject({ completed: true, attempts: 1, bestScore: r.score });
  });

  it('the trim step waits for hands-off flight and says so', async () => {
    const ac = basicAircraft();
    const { runner, rec } = await lesson(BASIC_FLIGHT, ac);
    const holding: Policy = (a, step, t) => { basicPolicy(a, step, t); a.inputs.pitch = 0.2; };
    for (let i = 0; i < 60 && runner.running && runner.step?.id !== 'trim'; i++) runnerFly(runner, ac, holding, 10);
    expect(runner.step?.id).toBe('trim');
    runnerFly(runner, ac, holding, 30);
    expect(runner.step?.id).toBe('trim');
    expect(texts(rec)).toContain('Trim to relieve the control pressure');
    runnerFly(runner, ac, (a, step, t) => { basicPolicy(a, step, t); a.inputs.pitch = 0; }, 15);
    expect(runner.result?.success).toBe(true);
  });

  it('a crash ends the lesson as incomplete with the reason', async () => {
    const ac = basicAircraft();
    const { runner, rec, events, store } = await lesson(BASIC_FLIGHT, ac);
    runnerFly(runner, ac, basicPolicy, 25);
    events.emit('aircraft:crash', { reason: 'overstress' });
    expect(runner.result).toMatchObject({ success: false, grade: 'Incomplete', reason: 'Crash: overstress' });
    expect(rec.of('activity:finished')).toMatchObject([{ success: false }]);
    expect(texts(rec)).toContain(BASIC_FLIGHT.debrief!.fail.text);
    expect(store.lesson(BASIC_FLIGHT.id)).toMatchObject({ completed: false, attempts: 1 });
  });
});

// ───────────────────────────── Takeoff ─────────────────────────────

function takeoffAircraft(): ScriptedAircraft {
  const p = destinationPoint({ lat: KSFO_28R.lat, lon: KSFO_28R.lon, alt: 0 }, KSFO_28R.headingDeg, KSFO_28R.displacedM + 30);
  const ac = new ScriptedAircraft({ lat: p.lat, lon: p.lon, altFt: KSFO_28R.elevM / FT, groundFt: KSFO_28R.elevM / FT, hdgTrue: KSFO_28R.headingDeg, iasKt: 0, onGround: true });
  ac.inputs.parkingBrake = true;
  ac.inputs.mixture = 0.7;
  ac.inputs.throttle = 0.1;
  return ac;
}

/** Rotate at `vrKt` with an optional sideways drift (m/s) on the roll. */
const takeoffPolicy = (vrKt = 55, driftMs = 0): Policy => (a, step) => {
  if (step === 'checks') { a.inputs.parkingBrake = false; a.inputs.mixture = 1; a.flapDeg = 10; return; }
  if (step === 'roll') {
    a.inputs.throttle = 1;
    a.driftMs = a.onGround ? driftMs : 0;
    if (a.onGround) {
      a.iasKt += 5 * DT;
      if (a.iasKt >= vrKt) a.pitchDeg = 8;
      if (a.iasKt >= vrKt + 3) { a.onGround = false; a.vsFpm = 700; }
    }
    return;
  }
  a.iasKt = 74;
  if (step === 'vy' || step === 'flapsUp') a.vsFpm = 700;
  if (step === 'flapsUp') a.flapDeg = 0;
  if (step === 'climb1500') a.steer({ altFt: 1500, maxVsFpm: 700 });
  if (step === 'level1500') { a.steer({ altFt: 1500 }); a.iasKt = 100; a.inputs.throttle = 0.75; }
};

describe('lesson: takeoff', () => {
  it('checks wait for the pilot; then roll, rotate at 55, Vy, flaps up and level at 1,500 ft', async () => {
    const ac = takeoffAircraft();
    const { runner, rec, host } = await lesson(TAKEOFF, ac);
    expect(host.calls).toEqual(['weather few', 'spawnAtRunway KSFO 28R', 'time morning']);
    expect(host.lastRunwaySpawn?.opts).toMatchObject({ parkingBrake: true });
    runnerFly(runner, ac, () => { /* brake still set */ }, 12);
    expect(runner.step?.id).toBe('checks');
    expect(texts(rec)).toContain('Release the parking brake');
    runnerFly(runner, ac, takeoffPolicy(), 400);
    const r = runner.result!;
    expect(r.success, r.summary).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.steps.map((s) => s.id)).toEqual(TAKEOFF.steps.map((s) => s.id));
    const rotate = r.steps[1].objectives.find((o) => o.label === 'Rotate at 55 KIAS')!;
    expect(rotate).toMatchObject({ state: 'done', note: 'Rotated at 55 kt' });
    // each cue once, in order
    const t = texts(rec);
    expect(t.filter((x) => x === 'Airspeed alive.').length).toBe(1);
    expect(t.filter((x) => x === '55 knots: rotate.').length).toBe(1);
    expect(t.indexOf('Airspeed alive.')).toBeLessThan(t.indexOf('55 knots: rotate.'));
    expect(t).toContain('Positive climb.');
  });

  it('drifting off the centreline on the roll fails the lesson', async () => {
    const ac = takeoffAircraft();
    const { runner, rec } = await lesson(TAKEOFF, ac);
    runnerFly(runner, ac, takeoffPolicy(55, 3), 120);
    expect(runner.result).toMatchObject({ success: false, reason: 'Drifted off the centreline during the takeoff roll' });
    expect(rec.of('activity:finished').length).toBe(1);
    expect(ac.onGround).toBe(true); // it failed during the roll, before rotation
  });

  it('a reset on the runway (simulator "reset flight") restarts the lesson at the checks', async () => {
    const ac = takeoffAircraft();
    const { runner, rec, events } = await lesson(TAKEOFF, ac);
    runnerFly(runner, ac, takeoffPolicy(), 20);
    expect(runner.stepIndex).toBeGreaterThan(0);
    const p = destinationPoint({ lat: KSFO_28R.lat, lon: KSFO_28R.lon, alt: 0 }, KSFO_28R.headingDeg, 131);
    events.emit('flight:reset', { spawn: { geo: { lat: p.lat, lon: p.lon, alt: 4 }, headingRad: KSFO_28R.headingDeg * DEG, speedMs: 0, onGround: true, engineRunning: true } });
    expect(runner.running).toBe(true);
    expect(runner.step?.id).toBe('checks');
    expect(rec.of('activity:finished').length).toBe(0);
  });

  it('rotating at 40 kt fails (strict), with the measured speed in the debrief', async () => {
    const ac = takeoffAircraft();
    const { runner } = await lesson(TAKEOFF, ac);
    runnerFly(runner, ac, takeoffPolicy(40), 120);
    expect(runner.result?.success).toBe(false);
    expect(runner.result?.reason).toBe('Rotated too early at 40 kt (target 55 kt)');
  });
});

// ───────────────────────────── Landing ─────────────────────────────

const HAF_END = runwayEndRef(KHAF_30);
const HAF_AIM = aimAlongM(KHAF_30);

function landingAircraft(): ScriptedAircraft {
  const s = LANDING.setup;
  if (s.spawn !== 'air') throw new Error('air start expected');
  return new ScriptedAircraft({ lat: s.lat, lon: s.lon, altFt: s.altFt, groundFt: KHAF_30.elevM / FT, hdgTrue: s.headingDeg, iasKt: s.iasKt, flapDeg: 20 });
}

/** 3° to the aim point (+ extraM long), flaps 30 at `flapsAtNm` (null: never), flare, rollout. */
const landingPolicy = (opts: { flapsAtNm?: number | null; extraM?: number } = {}): Policy => (a) => {
  const rel = relativeToRunway({ lat: a.lat, lon: a.lon, alt: 0 }, HAF_END);
  if (opts.flapsAtNm !== null && -rel.alongM / NM <= (opts.flapsAtNm ?? 2)) a.flapDeg = 30;
  if (a.onGround) { a.iasKt = Math.max(0, a.iasKt - 5 * DT); a.inputs.throttle = 0; return; }
  a.iasKt = 63;
  const toAim = HAF_AIM + (opts.extraM ?? 0) - rel.alongM;
  const wantFt = (KHAF_30.elevM + Math.max(toAim, 0) * Math.tan(3 * D2R)) / FT;
  a.vsFpm = -a.iasKt * KT * Math.tan(3 * D2R) * 196.85 + (wantFt - a.altFt) * 3;
  if (a.aglFt < 20) a.vsFpm = Math.max(a.vsFpm, -150);
  if (a.altFt + (a.vsFpm / 60) * DT <= a.groundFt) { a.onGround = true; a.altFt = a.groundFt; a.vsFpm = 0; }
};

describe('lesson: landing', () => {
  it('a stable approach and a touchdown in the zone completes it; the landing scorer grades it', async () => {
    const ac = landingAircraft();
    const { runner, rec, host } = await lesson(LANDING, ac, [dataAirport('KHAF')]);
    expect(host.lastAirSpawn).toMatchObject({ headingDeg: 317, iasMs: 65 * KT, opts: { flapsIndex: 2 } });
    expect(host.lastAirSpawn!.opts!.gammaRad).toBeCloseTo(-3 * DEG, 9);
    runnerFly(runner, ac, landingPolicy(), 400);
    const r = runner.result!;
    expect(r.success, r.summary).toBe(true);
    expect(r.landingScore).toBeGreaterThanOrEqual(4000);
    const td = r.steps[1].objectives[0];
    expect(td.state).toBe('done');
    expect(td.note).toMatch(/^Landing score \d+ \(/);
    const t = texts(rec);
    expect(t.filter((x) => x === 'Flare: ease back, hold it off.').length).toBe(1);
    expect(t).not.toContain('Flaps 30 now.'); // set at 2 nm, before the 1.6 nm reminder
    expect(r.score).toBeGreaterThanOrEqual(80);
  });

  it('flaps not at 30° by 1 nm fails the lesson, after a reminder', async () => {
    const ac = landingAircraft();
    const { runner, rec } = await lesson(LANDING, ac, [dataAirport('KHAF')]);
    runnerFly(runner, ac, landingPolicy({ flapsAtNm: null }), 400);
    expect(runner.result).toMatchObject({ success: false, reason: 'Flaps were not at 30° by 1 nm' });
    expect(texts(rec).filter((x) => x === 'Flaps 30 now.').length).toBe(1);
  });

  it('a long landing outside the touchdown zone fails with the measured distance', async () => {
    const ac = landingAircraft();
    const { runner } = await lesson(LANDING, ac, [dataAirport('KHAF')]);
    runnerFly(runner, ac, landingPolicy({ extraM: 600 }), 400);
    expect(runner.result?.success).toBe(false);
    expect(runner.result?.reason).toMatch(/^Touched down \d+ m past the threshold, outside the touchdown zone \(233–683 m\)$/);
    expect(runner.result?.landingScore).not.toBeNull();
  });

  it('a go-around is not a dead end: after a circuit the next landing counts', async () => {
    const ac = landingAircraft();
    const { runner } = await lesson(LANDING, ac, [dataAirport('KHAF')]);
    runnerFly(runner, ac, landingPolicy(), 400, () => runner.step?.id === 'touchdown');
    expect(runner.step?.id).toBe('touchdown');
    // go around: climb away for a minute
    runnerFly(runner, ac, (a) => { a.vsFpm = 700; a.flapDeg = 10; a.iasKt = 70; }, 60);
    expect(runner.running).toBe(true);
    expect(runner.objectives[0].state).toBe('active');
    // the circuit (not simulated): back on a 2 nm final on the glidepath, then land
    const p = destinationPoint({ lat: KHAF_30.lat, lon: KHAF_30.lon, alt: 0 }, KHAF_30.headingDeg + 180, 2 * NM);
    Object.assign(ac, { lat: p.lat, lon: p.lon, hdgTrue: KHAF_30.headingDeg, altFt: (KHAF_30.elevM + (2 * NM + HAF_AIM) * Math.tan(3 * D2R)) / FT, flapDeg: 30 });
    runnerFly(runner, ac, landingPolicy(), 400);
    expect(runner.result?.success).toBe(true);
  });
});
