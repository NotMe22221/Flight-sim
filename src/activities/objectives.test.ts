import { describe, expect, it } from 'vitest';
import type { AircraftState, ControlInputs } from '../core/types';
import { FT, NM } from '../core/units';
import { destinationPoint } from '../geo/wgs84';
import { flyState, inputsWith, type FlyParams } from './activityTestKit';
import { KHAF_30, KSFO_28R } from './lessons';
import {
  angleDiffDeg, compileCondition, compileObjective, makeObjectiveContext, scoreLoss,
  type ConditionSpec, type Objective, type ObjectiveContext, type ObjectiveSpec,
} from './objectives';
import { aimAlongM } from './runwayFrame';

interface Frame { s: AircraftState; i?: ControlInputs }

/** Activate an objective and feed it frames every dt until it finishes or `seconds` elapse. */
function run(spec: ObjectiveSpec, frame: (t: number) => Frame, seconds: number, dt = 0.1): { o: Objective; t: number; ctx: ObjectiveContext } {
  const o = compileObjective(spec);
  const f0 = frame(0);
  const ctx = makeObjectiveContext(f0.s, f0.i ?? inputsWith());
  o.activate(ctx);
  let t = 0;
  while (t < seconds - 1e-9 && !o.finished) {
    t += dt;
    const f = frame(t);
    ctx.state = f.s;
    if (f.i) ctx.inputs = f.i;
    ctx.dt = dt;
    o.update(ctx);
  }
  return { o, t, ctx };
}

const at = (p: FlyParams): Frame => ({ s: flyState(p) });
const test1 = (spec: ConditionSpec, s: AircraftState, i: ControlInputs = inputsWith()) => {
  const c = compileCondition(spec);
  const ctx = makeObjectiveContext(s, i);
  c.activate(ctx);
  const ok = c.test(ctx);
  return { ok, hint: c.hint?.text ?? null, err: c.err, speech: c.hint?.speech ?? null };
};

/** A point on the extended centreline `distM` before the threshold (negative = past it), `crossM` right. */
const onFinal = (rw: typeof KHAF_30, distM: number, crossM = 0) =>
  destinationPoint(destinationPoint({ lat: rw.lat, lon: rw.lon, alt: 0 }, rw.headingDeg + 180, distM), rw.headingDeg + 90, crossM);

describe('conditions', () => {
  it('altitude band with directional hints spelled for speech', () => {
    expect(test1({ c: 'altitude', ft: 3000, tolFt: 100 }, flyState({ altFt: 3050 })).ok).toBe(true);
    const high = test1({ c: 'altitude', ft: 3000, tolFt: 100 }, flyState({ altFt: 3200 }));
    expect(high).toMatchObject({ ok: false, hint: 'Too high: descend to 3,000 ft' });
    expect(high.speech).toContain('three thousand feet');
    expect(test1({ c: 'altitude', ft: 3000, tolFt: 100 }, flyState({ altFt: 2850 })).hint).toBe('Too low: climb to 3,000 ft');
    expect(test1({ c: 'altitude', ft: 3000, tolFt: 100 }, flyState({ altFt: 3050 })).err).toBeCloseTo(0.5, 6);
  });
  it('heading uses the magnetic heading and the shortest turn', () => {
    expect(test1({ c: 'heading', deg: 90, tolDeg: 10 }, flyState({ hdgDeg: 103, magHdgDeg: 88 })).ok).toBe(true);
    expect(test1({ c: 'heading', deg: 90, tolDeg: 10 }, flyState({ magHdgDeg: 70 })).hint).toBe('Turn right to heading 090');
    expect(test1({ c: 'heading', deg: 10, tolDeg: 10 }, flyState({ magHdgDeg: 340 })).hint).toBe('Turn right to heading 010');
    expect(test1({ c: 'heading', deg: 350, tolDeg: 5, ref: 'true' }, flyState({ hdgDeg: 20 })).hint).toBe('Turn left to heading 350');
    expect(angleDiffDeg(10, 350)).toBe(20);
  });
  it('airspeed, vertical speed, bank and pitch bands', () => {
    expect(test1({ c: 'airspeed', minKt: 60, maxKt: 65 }, flyState({ iasKt: 70 })).hint).toBe('Too fast: reduce power');
    expect(test1({ c: 'airspeed', minKt: 60, maxKt: 65 }, flyState({ iasKt: 55 })).hint).toBe('Too slow: add power');
    expect(test1({ c: 'airspeed', minKt: 69, maxKt: 79, lowHint: { text: 'Too slow: lower the nose' } }, flyState({ iasKt: 60 })).hint).toBe('Too slow: lower the nose');
    expect(test1({ c: 'verticalSpeed', minFpm: 200, maxFpm: 1000 }, flyState({ vsFpm: 1500 })).hint).toBe('Climbing too fast: lower the nose');
    expect(test1({ c: 'verticalSpeed', minFpm: -1000, maxFpm: -200 }, flyState({ vsFpm: -1500 })).hint).toBe('Sinking too fast: raise the nose');
    expect(test1({ c: 'bank', maxDeg: 5 }, flyState({ bankDeg: -12 })).hint).toBe('Level the wings');
    expect(test1({ c: 'bank', minDeg: 10, maxDeg: 22 }, flyState({ bankDeg: -15 })).ok).toBe(true);
    expect(test1({ c: 'pitch', minDeg: 2, maxDeg: 10 }, flyState({ pitchDeg: 12 })).hint).toBe('Nose too high: lower the nose');
  });
  it('controls and configuration', () => {
    expect(test1({ c: 'parkingBrake', set: false }, flyState(), inputsWith({ parkingBrake: true })).hint).toBe('Release the parking brake');
    expect(test1({ c: 'throttle', min: 0.95 }, flyState(), inputsWith({ throttle: 0.5 })).hint).toBe('Full power: throttle all the way in');
    expect(test1({ c: 'mixture', min: 0.95 }, flyState(), inputsWith({ mixture: 0.6 })).hint).toBe('Mixture full rich');
    expect(test1({ c: 'flaps', minDeg: 30 }, flyState({ flapDeg: 20 })).hint).toBe('Flaps down to 30°');
    expect(test1({ c: 'flaps', maxDeg: 0 }, flyState({ flapDeg: 10 })).hint).toBe('Flaps up');
    expect(test1({ c: 'flaps', minDeg: 30 }, flyState({ flapDeg: 29.8 })).ok).toBe(true);
    expect(test1({ c: 'controlsNeutral' }, flyState(), inputsWith({ pitch: 0.2 })).hint).toBe('Trim to relieve the control pressure');
    expect(test1({ c: 'controlsNeutral' }, flyState(), inputsWith({ pitch: 0.02 })).ok).toBe(true);
    const off = flyState(); off.engine.running = false;
    expect(test1({ c: 'engineRunning', value: true }, off).hint).toBe('Start the engine');
  });
  it('ground, AGL and distance conditions', () => {
    expect(test1({ c: 'onGround', value: true }, flyState({ onGround: true })).ok).toBe(true);
    expect(test1({ c: 'groundSpeed', maxKt: 1 }, flyState({ onGround: true, iasKt: 5 })).hint).toBe('Slow down: apply the brakes');
    expect(test1({ c: 'agl', minFt: 500 }, flyState({ aglFt: 300 })).hint).toBe('Climb to 500 ft above the ground');
    expect(test1({ c: 'altitudeBand', minFt: 1000, maxFt: 2000 }, flyState({ altFt: 2500 })).hint).toBe('Descend below 2,000 ft');
    const p = destinationPoint({ lat: 37, lon: -122, alt: 0 }, 45, 900);
    expect(test1({ c: 'near', lat: 37, lon: -122, radiusM: 1000 }, flyState({ lat: p.lat, lon: p.lon })).ok).toBe(true);
    expect(test1({ c: 'near', lat: 37, lon: -122, radiusM: 800 }, flyState({ lat: p.lat, lon: p.lon })).ok).toBe(false);
  });
  it('centreline offset sign gives the steering hint', () => {
    const right = onFinal(KSFO_28R, -500, 12);
    expect(test1({ c: 'centreline', runway: KSFO_28R, maxM: 10 }, flyState({ lat: right.lat, lon: right.lon, onGround: true })).hint).toBe('Right of the centreline: steer left');
    const left = onFinal(KSFO_28R, -500, -12);
    expect(test1({ c: 'centreline', runway: KSFO_28R, maxM: 10 }, flyState({ lat: left.lat, lon: left.lon, onGround: true })).hint).toBe('Left of the centreline: steer right');
    const ok = onFinal(KSFO_28R, -500, 3);
    expect(test1({ c: 'centreline', runway: KSFO_28R, maxM: 10 }, flyState({ lat: ok.lat, lon: ok.lon, onGround: true })).err).toBeCloseTo(0.3, 1);
  });
  it('glidepath follows the 3° path to the displaced-threshold aim point', () => {
    const aim = aimAlongM({ lengthM: KHAF_30.lengthM, displacedM: KHAF_30.displacedM });
    expect(aim).toBeCloseTo(233 + 150, 6);
    const path = (d: number) => (KHAF_30.elevM + (d + aim) * Math.tan(3 * Math.PI / 180)) / FT;
    const d = 2 * NM;
    const p = onFinal(KHAF_30, d);
    const spec: ConditionSpec = { c: 'glidepath', runway: KHAF_30, tolDeg: 0.7, minTolFt: 20 };
    expect(test1(spec, flyState({ lat: p.lat, lon: p.lon, altFt: path(d) })).ok).toBe(true);
    expect(test1(spec, flyState({ lat: p.lat, lon: p.lon, altFt: path(d) + 250 })).hint).toBe('Above the glidepath: reduce power');
    expect(test1(spec, flyState({ lat: p.lat, lon: p.lon, altFt: path(d) - 250 })).hint).toBe('Below the glidepath: add power');
    // 0.7° at 2 nm is ~150 ft: 100 ft high is inside, err ≈ 0.66
    expect(test1(spec, flyState({ lat: p.lat, lon: p.lon, altFt: path(d) + 100 })).err).toBeCloseTo(100 / (((d + aim) * (Math.tan(3.7 * Math.PI / 180) - Math.tan(3 * Math.PI / 180))) / FT), 2);
    expect(test1({ c: 'runwayDistance', runway: KHAF_30, maxNm: 1 }, flyState({ lat: p.lat, lon: p.lon })).ok).toBe(false);
    const p2 = onFinal(KHAF_30, 0.9 * NM);
    expect(test1({ c: 'runwayDistance', runway: KHAF_30, maxNm: 1 }, flyState({ lat: p2.lat, lon: p2.lon })).ok).toBe(true);
  });
});

describe('hold objective', () => {
  const spec: ObjectiveSpec = { type: 'hold', label: 'hold', forS: 20, all: [{ c: 'altitude', ft: 3000, tolFt: 100 }, { c: 'heading', deg: 90, tolDeg: 10 }] };
  it('completes after holding for forS, with progress on the way', () => {
    const half = run(spec, () => at({ altFt: 3020, magHdgDeg: 92 }), 10);
    expect(half.o.view.state).toBe('active');
    expect(half.o.view.progress).toBeCloseTo(0.5, 2);
    expect(half.o.view.hint).toBeNull();
    const full = run(spec, () => at({ altFt: 3020, magHdgDeg: 92 }), 30);
    expect(full.o.view.state).toBe('done');
    expect(full.t).toBeCloseTo(20, 1);
    expect(full.o.view.score).toBeGreaterThan(0.85);
  });
  it('a long excursion resets the timer, a short one only pauses it', () => {
    const long = run(spec, (t) => at({ altFt: t > 8 && t < 11 ? 3300 : 3000, magHdgDeg: 90 }), 25);
    expect(long.o.view.state).toBe('active'); // reset at ~9 s → needs until ~31 s
    expect(long.o.view.progress).toBeLessThan(0.8);
    const short = run(spec, (t) => at({ altFt: t > 8 && t < 8.6 ? 3300 : 3000, magHdgDeg: 90 }), 25);
    expect(short.o.view.state).toBe('done');
  });
  it('reports the failing condition as the hint and fails on timeout', () => {
    const r = run({ ...spec, timeoutS: 5, failText: 'Took too long' }, () => at({ altFt: 3300, magHdgDeg: 90 }), 4);
    expect(r.o.view.hint?.text).toBe('Too high: descend to 3,000 ft');
    const r2 = run({ ...spec, timeoutS: 5, failText: 'Took too long' }, () => at({ altFt: 3300, magHdgDeg: 90 }), 10);
    expect(r2.o.view.state).toBe('failed');
    expect(r2.o.view.note).toBe('Took too long');
    expect(r2.o.view.score).toBe(0);
  });
});

describe('reach objective', () => {
  it('climb: progress by altitude, VS band coached and scored', () => {
    const spec: ObjectiveSpec = {
      type: 'reach', label: 'climb', all: [{ c: 'altitude', ft: 3500, tolFt: 60 }],
      during: [{ c: 'verticalSpeed', minFpm: 200, maxFpm: 1200 }], progress: { metric: 'altitudeFt', to: 3500 },
    };
    const climb = (fpm: number) => (t: number) => at({ altFt: Math.min(3000 + (fpm / 60) * t, 3500), vsFpm: fpm });
    const mid = run(spec, climb(600), 25);
    expect(mid.o.view.progress).toBeCloseTo(0.5, 1);
    expect(mid.o.view.hint).toBeNull();
    const done = run(spec, climb(600), 120);
    expect(done.o.view.state).toBe('done');
    expect(done.o.view.score).toBeCloseTo(1, 6);
    const steep = run(spec, climb(2000), 5);
    expect(steep.o.view.hint?.text).toBe('Climbing too fast: lower the nose');
    const steepDone = run(spec, climb(2000), 60);
    expect(steepDone.o.view.state).toBe('done');
    expect(steepDone.o.view.score).toBeLessThan(0.6);
  });
  it('no headway for 15 s brings back the target hint', () => {
    const spec: ObjectiveSpec = { type: 'reach', label: 'climb', all: [{ c: 'altitude', ft: 3500, tolFt: 60 }], progress: { metric: 'altitudeFt', to: 3500 } };
    expect(run(spec, () => at({ altFt: 3000 }), 10).o.view.hint).toBeNull();
    expect(run(spec, () => at({ altFt: 3000 }), 20).o.view.hint?.text).toBe('Too low: climb to 3,500 ft');
  });
  it('switch objectives: parking brake, throttle, flaps detent, AGL', () => {
    const brake = run({ type: 'reach', label: 'brake', all: [{ c: 'parkingBrake', set: false }] }, (t) => ({ s: flyState({ onGround: true }), i: inputsWith({ parkingBrake: t < 3 }) }), 10);
    expect(brake.o.view.state).toBe('done');
    expect(brake.t).toBeGreaterThan(3.3); // released at 3.0 s + 0.5 s confirmation
    expect(brake.t).toBeLessThan(3.6);
    const pending = run({ type: 'reach', label: 'brake', all: [{ c: 'parkingBrake', set: false }] }, () => ({ s: flyState({ onGround: true }), i: inputsWith({ parkingBrake: true }) }), 2);
    expect(pending.o.view.hint?.text).toBe('Release the parking brake');
    const thr = run({ type: 'reach', label: 'power', all: [{ c: 'throttle', min: 0.95 }] }, (t) => ({ s: flyState({ onGround: true }), i: inputsWith({ throttle: Math.min(1, t / 4) }) }), 10);
    expect(thr.o.view.state).toBe('done');
    const flaps = run({ type: 'reach', label: 'flaps', all: [{ c: 'flaps', minDeg: 30 }] }, (t) => at({ flapDeg: Math.min(30, 20 + 4 * t) }), 10);
    expect(flaps.o.view.state).toBe('done');
    const agl = run({ type: 'reach', label: 'agl', all: [{ c: 'agl', minFt: 500 }], progress: { metric: 'aglFt', to: 500 } }, (t) => at({ aglFt: 10 * t, altFt: 10 * t }), 30);
    expect(agl.o.view.progress).toBeCloseTo(0.6, 1);
    expect(run({ type: 'reach', label: 'agl', all: [{ c: 'agl', minFt: 500 }] }, (t) => at({ aglFt: 10 * t, altFt: 10 * t }), 60).o.view.state).toBe('done');
  });
  it('a failIf deadline fails it: flaps 30 by 1 nm', () => {
    const spec: ObjectiveSpec = {
      type: 'reach', label: 'Flaps 30 by 1 nm', all: [{ c: 'flaps', minDeg: 30 }],
      failIf: [{ c: 'runwayDistance', runway: KHAF_30, maxNm: 1 }], failText: 'Flaps were not at 30° by 1 nm',
    };
    // 65 kt from 3 nm: 1 nm is reached after ~111 s
    const late = run(spec, (t) => { const p = onFinal(KHAF_30, 3 * NM - 33.4 * t); return at({ lat: p.lat, lon: p.lon, flapDeg: 20 }); }, 200);
    expect(late.o.view.state).toBe('failed');
    expect(late.o.view.note).toBe('Flaps were not at 30° by 1 nm');
    expect(late.t).toBeGreaterThan(100);
    expect(late.t).toBeLessThan(120);
    const inTime = run(spec, (t) => { const p = onFinal(KHAF_30, 3 * NM - 33.4 * t); return at({ lat: p.lat, lon: p.lon, flapDeg: t > 60 ? 30 : 20 }); }, 200);
    expect(inTime.o.view.state).toBe('done');
  });
});

describe('maintain objective', () => {
  const vy: ObjectiveSpec = {
    type: 'maintain', label: 'Vy', all: [{ c: 'airspeed', minKt: 69, maxKt: 79, highHint: { text: 'Too fast: raise the nose' } }],
    until: [{ c: 'agl', minFt: 500 }], progress: { metric: 'aglFt', to: 500 },
  };
  it('scores the time in band and completes at the until condition', () => {
    const r = run(vy, (t) => at({ iasKt: 74, aglFt: 12 * t, altFt: 12 * t }), 60);
    expect(r.o.view.state).toBe('done');
    expect(r.o.view.score).toBeGreaterThan(0.95);
    const fast = run(vy, (t) => at({ iasKt: t < 20 ? 85 : 74, aglFt: 12 * t, altFt: 12 * t }), 10);
    expect(fast.o.view.hint?.text).toBe('Too fast: raise the nose');
    expect(fast.o.view.progress).toBeCloseTo(0.24, 1);
    const fastDone = run(vy, (t) => at({ iasKt: t < 20 ? 85 : 74, aglFt: 12 * t, altFt: 12 * t }), 60);
    expect(fastDone.o.view.state).toBe('done');
    expect(fastDone.o.view.score).toBeLessThan(0.6);
  });
  it('fails after failAfterS continuous seconds off the centreline', () => {
    const spec: ObjectiveSpec = { type: 'maintain', label: 'centreline', all: [{ c: 'centreline', runway: KSFO_28R, maxM: 10 }], until: [{ c: 'agl', minFt: 20 }], failAfterS: 5 };
    const drift = run(spec, (t) => { const p = onFinal(KSFO_28R, -300 - 20 * t, t < 3 ? 2 : 15); return at({ lat: p.lat, lon: p.lon, onGround: true, aglFt: 0, altFt: 13 }); }, 20);
    expect(drift.o.view.state).toBe('failed');
    expect(drift.t).toBeGreaterThan(7.9); // off from 3 s, fails after 5 s continuously off
    expect(drift.t).toBeLessThan(8.5);
    const brief = run(spec, (t) => { const p = onFinal(KSFO_28R, -300 - 20 * t, t > 3 && t < 6 ? 15 : 2); return at({ lat: p.lat, lon: p.lon, onGround: t < 15, aglFt: t < 15 ? 0 : 30, altFt: 13 }); }, 20);
    expect(brief.o.view.state).toBe('done');
  });
});

describe('turn objective', () => {
  /** Coordinated turn with a constant bank until within `stopAt` of the target change, then wings level. */
  const turnFrames = (bankDeg: number, rateDegS: number, stopDeg: number, h0 = 90) => {
    let hdg = h0, turned = 0, last = 0;
    return (t: number): Frame => {
      const dt = t - last; last = t;
      const banking = Math.abs(turned) < stopDeg;
      if (banking) { hdg += rateDegS * dt * Math.sign(bankDeg); turned += rateDegS * dt * Math.sign(bankDeg); }
      return at({ hdgDeg: hdg, magHdgDeg: hdg, bankDeg: banking ? bankDeg : 0, altFt: 3500 });
    };
  };
  const right: ObjectiveSpec = { type: 'turn', label: 'right 90', byDeg: 90, bankMinDeg: 10, bankMaxDeg: 22, tolDeg: 10, during: [{ c: 'altitude', ft: 3500, tolFt: 150 }] };
  it('a standard-rate right turn: progress, completion and a high score', () => {
    const mid = run(right, turnFrames(15, 3, 88), 15);
    expect(mid.o.view.progress).toBeCloseTo(0.5, 1);
    expect(mid.o.view.hint).toBeNull();
    const r = run(right, turnFrames(15, 3, 88), 60);
    expect(r.o.view.state).toBe('done');
    expect(r.o.view.score).toBeGreaterThan(0.9);
  });
  it('a left turn the other way', () => {
    const r = run({ ...right, byDeg: -90 }, turnFrames(-15, 3, 85), 60);
    expect(r.o.view.state).toBe('done');
  });
  it('hints: too shallow, too steep, roll out, overshoot', () => {
    expect(run(right, turnFrames(5, 1, 88), 5).o.view.hint?.text).toBe('Bank a little more: about 16°');
    const steep = run(right, turnFrames(35, 7, 88), 4);
    expect(steep.o.view.hint?.text).toBe('Too steep: reduce the bank to about 16°');
    expect(steep.o.view.hint?.speech).toContain('about sixteen degrees');
    const still = run(right, turnFrames(15, 3, 200), 31);
    expect(still.o.view.hint?.text).toBe('Roll out on heading 180');
    const over = run(right, turnFrames(15, 3, 200), 40);
    expect(over.o.view.hint?.text).toBe('Overshot: turn back to heading 180');
    expect(over.o.view.state).toBe('active');
    expect(run(right, () => at({ hdgDeg: 90, magHdgDeg: 90 }), 6).o.view.hint?.text).toBe('Roll right to turn to heading 180');
  });
  it('time out of the bank band lowers the score', () => {
    const r = run(right, turnFrames(30, 6, 88), 60);
    expect(r.o.view.state).toBe('done');
    expect(r.o.view.score).toBeLessThan(0.5);
  });
});

describe('rotate objective', () => {
  const spec: ObjectiveSpec = { type: 'rotate', label: 'Rotate at 55', minKt: 48, maxKt: 65, targetKt: 55, strict: true };
  /** Accelerate at 2.5 kt/s on the ground, pitch up 8° from `rotateKt`. */
  const roll = (rotateKt: number) => (t: number): Frame => {
    const kt = 2.5 * t;
    return at({ onGround: true, iasKt: kt, pitchDeg: kt >= rotateKt ? 8 : 0, aglFt: 0, altFt: 13 });
  };
  it('rotation in the band completes with the measured speed', () => {
    const mid = run(spec, roll(55), 11);
    expect(mid.o.view.progress).toBeCloseTo(0.5, 1);
    expect(mid.o.view.hint).toBeNull();
    expect(run(spec, roll(55), 20).o.view.hint?.text).toBe('Rotate: ease back on the yoke at 55 kt');
    const r = run(spec, roll(55), 40);
    expect(r.o.view.state).toBe('done');
    expect(r.o.view.note).toBe('Rotated at 55 kt');
    expect(r.o.view.score).toBeGreaterThan(0.95);
  });
  it('too early fails when strict; late is only penalised when not strict', () => {
    const early = run(spec, roll(40), 40);
    expect(early.o.view.state).toBe('failed');
    expect(early.o.view.note).toContain('too early at 40 kt');
    const late = run({ ...spec, strict: false }, roll(70), 40);
    expect(late.o.view.state).toBe('done');
    expect(late.o.view.score).toBeCloseTo(0.3, 6);
    expect(late.o.view.note).toContain('late at 70 kt');
  });
  it('a lift-off without a pitch-up also counts as rotation', () => {
    const r = run(spec, (t) => at({ onGround: 2.5 * t < 57, iasKt: 2.5 * t, aglFt: 2.5 * t < 57 ? 0 : 10, altFt: 13 }), 40);
    expect(r.o.view.state).toBe('done');
    expect(r.o.view.note).toBe('Rotated at 57 kt');
  });
});

describe('stopAt objective', () => {
  const dest = { lat: 36.935699, lon: -121.790001 };
  const spec: ObjectiveSpec = { type: 'stopAt', label: 'Stop at KWVI', icao: 'KWVI', name: 'Watsonville', ...dest, radiusM: 2500 };
  it('needs a flight, the field, and a full stop', () => {
    const p = destinationPoint({ ...dest, alt: 0 }, 0, 400);
    // airborne 10 nm out → landed rolling → stopped
    const frames = (t: number): Frame => {
      if (t < 5) { const q = destinationPoint({ ...dest, alt: 0 }, 0, 18520 - 3000 * t); return at({ lat: q.lat, lon: q.lon, altFt: 1500 }); }
      return at({ lat: p.lat, lon: p.lon, onGround: true, iasKt: t < 10 ? 30 : 0, altFt: 160, aglFt: 0 });
    };
    expect(run(spec, frames, 4).o.view.progress).toBeGreaterThan(0.5);
    const rolling = run(spec, frames, 8);
    expect(rolling.o.view.hint?.text).toBe('Brake to a full stop at Watsonville');
    const r = run(spec, frames, 30);
    expect(r.o.view.state).toBe('done');
    expect(r.t).toBeCloseTo(12, 0);
  });
  it('stopping elsewhere is not the destination; standing at the field without flying does not count', () => {
    const elsewhere = destinationPoint({ ...dest, alt: 0 }, 0, 20000);
    const frames = (t: number): Frame => (t < 2 ? at({ lat: elsewhere.lat, lon: elsewhere.lon, altFt: 1500 }) : at({ lat: elsewhere.lat, lon: elsewhere.lon, onGround: true, iasKt: 0, aglFt: 0 }));
    const r = run(spec, frames, 20);
    expect(r.o.view.state).toBe('active');
    expect(r.o.view.hint?.text).toBe("This isn't Watsonville: take off and continue to KWVI");
    const parked = run(spec, () => at({ ...dest, onGround: true, iasKt: 0, aglFt: 0 }), 20);
    expect(parked.o.view.state).toBe('active');
  });
});

describe('landing objective', () => {
  const spec: ObjectiveSpec = { type: 'landing', label: 'Land', minScore: 4000, runway: 'KHAF 30', zone: { fromM: 233, toM: 683 } };
  const landWith = (score: number, runway: string | null, tdM: number | null) => {
    const o = compileObjective(spec);
    const ctx = makeObjectiveContext(flyState(), inputsWith());
    o.activate(ctx);
    ctx.dt = 0.1;
    o.update(ctx);
    expect(o.view.state).toBe('active');
    ctx.landing = { score, runway, touchdownFromThresholdM: tdM, grade: 'Good' };
    ctx.landingSeq++;
    o.update(ctx);
    return o;
  };
  it('passes with a good landing in the zone on the right runway', () => {
    const o = landWith(8200, 'KHAF 30', 400);
    expect(o.view.state).toBe('done');
    expect(o.view.score).toBeCloseTo(0.82, 6);
    expect(o.view.note).toBe('Landing score 8200 (Good)');
  });
  it('fails on the wrong runway, outside the zone, or below the minimum score', () => {
    expect(landWith(8200, 'KHAF 12', 400).view.note).toBe('Landed on KHAF 12, not KHAF 30');
    expect(landWith(8200, 'KHAF 30', 900).view.note).toContain('outside the touchdown zone');
    expect(landWith(3000, 'KHAF 30', 400).view.state).toBe('failed');
  });
  it('ignores landings scored before it was activated', () => {
    const o = compileObjective(spec);
    const ctx = makeObjectiveContext(flyState(), inputsWith());
    ctx.landing = { score: 9000, runway: 'KHAF 30', touchdownFromThresholdM: 400, grade: 'Great' };
    ctx.landingSeq = 3;
    o.activate(ctx);
    ctx.dt = 0.1;
    o.update(ctx);
    expect(o.view.state).toBe('active');
  });
  it('airport-only matching for bush legs', () => {
    const o = compileObjective({ type: 'landing', label: 'Land at KWVI', minScore: 0, airport: 'KWVI' });
    const ctx = makeObjectiveContext(flyState(), inputsWith());
    o.activate(ctx);
    ctx.dt = 0.1;
    ctx.landing = { score: 6100, runway: 'KWVI 20', touchdownFromThresholdM: 300, grade: 'Firm' };
    ctx.landingSeq = 1;
    o.update(ctx);
    expect(o.view.state).toBe('done');
  });
});

describe('landing objective: elsewhere ignore', () => {
  it("bush legs skip landings at other airports and take the destination's", () => {
    const o = compileObjective({ type: 'landing', label: 'Land at KRHV', minScore: 0, airport: 'KRHV', elsewhere: 'ignore' });
    const ctx = makeObjectiveContext(flyState(), inputsWith());
    o.activate(ctx);
    ctx.dt = 0.1;
    ctx.landing = { score: 7000, runway: 'KHAF 30', touchdownFromThresholdM: 400, grade: 'Good' };
    ctx.landingSeq = 1;
    o.update(ctx);
    expect(o.view.state).toBe('active');
    ctx.landing = { score: 5400, runway: 'KRHV 31R', touchdownFromThresholdM: 300, grade: 'Firm' };
    ctx.landingSeq = 2;
    o.update(ctx);
    expect(o.view).toMatchObject({ state: 'done', note: 'Landing score 5400 (Firm)' });
  });
});

describe('scoring dead band', () => {
  it('no loss within 40 % of the tolerance, full loss at the edge', () => {
    expect(scoreLoss(0)).toBe(0);
    expect(scoreLoss(0.4)).toBe(0);
    expect(scoreLoss(0.7)).toBeCloseTo(0.5, 9);
    expect(scoreLoss(1)).toBe(1);
    expect(scoreLoss(3)).toBe(1);
    // a hold flown 30 ft off a ±100 ft target scores full marks, 90 ft off scores ~0.5
    const spec: ObjectiveSpec = { type: 'hold', label: 'hold', forS: 5, all: [{ c: 'altitude', ft: 3000, tolFt: 100 }] };
    expect(run(spec, () => at({ altFt: 3030 }), 10).o.view.score).toBeCloseTo(1, 6);
    expect(run(spec, () => at({ altFt: 3090 }), 10).o.view.score).toBeCloseTo(0.5, 6);
  });
});

describe('waypoint objective', () => {
  it('progress while approaching and done inside the radius', () => {
    const wp = { lat: 37.1817, lon: -122.3944 };
    const spec: ObjectiveSpec = { type: 'waypoint', label: 'Pigeon Point', name: 'Pigeon Point Lighthouse', ...wp, radiusM: 1.5 * NM };
    const frames = (t: number): Frame => { const p = destinationPoint({ ...wp, alt: 0 }, 0, 10 * NM - 51.4 * t); return at({ lat: p.lat, lon: p.lon }); };
    expect(run(spec, frames, 180).o.view.progress).toBeCloseTo(0.5, 1);
    const r = run(spec, frames, 400);
    expect(r.o.view.state).toBe('done');
    expect(r.o.view.note).toBe('Passed Pigeon Point Lighthouse');
    expect(r.t).toBeCloseTo((8.5 * NM) / 51.4, 0);
  });
});
