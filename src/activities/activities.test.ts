import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/events';
import { makeAircraftState } from '../core/fakeState';
import { defaultControlInputs, type Airport, type AircraftState, type Runway, type SimEvents } from '../core/types';
import { FPM, KT } from '../core/units';
import { destinationPoint } from '../geo/wgs84';
import { LANDING_CHALLENGES } from './landingChallenges';
import { scoreLanding } from './landingScore';
import { ReplayRecorder, emptyReplayFrame } from './ReplayRecorder';
import { aimPointM, matchRunwayEnd, relativeToRunway, runwayEnds } from './runwayFrame';
import { TouchdownDetector } from './TouchdownDetector';

const rw = (ident: string, a: [number, number, number], b: [number, number, number], headingDeg: number, lengthM: number): Runway => ({
  ident, threshold: { lat: a[0], lon: a[1], alt: a[2] }, end: { lat: b[0], lon: b[1], alt: b[2] }, headingDeg, lengthM, widthM: 61,
  surface: 'asphalt', lighted: true, displacedThresholdM: 0,
});
const KSFO: Airport = {
  icao: 'KSFO', name: 'San Francisco Intl', position: { lat: 37.619806, lon: -122.374821, alt: 4 }, elevationM: 4, type: 'large', country: 'US',
  runways: [
    rw('10L/28R', [37.628742, -122.39341, 1.5], [37.613538, -122.35716, 4], 118, 3618),
    rw('1R/19L', [37.606333, -122.381061, 3.7], [37.627346, -122.367124, 3], 28, 2640),
  ],
};
const end28R = runwayEnds(KSFO, KSFO.runways[0])[1];

describe('runwayFrame', () => {
  it('28R end has the reciprocal heading and the 28R threshold', () => {
    expect(end28R.ident).toBe('28R');
    expect(end28R.headingDeg).toBe(298);
    expect(end28R.threshold.lat).toBeCloseTo(37.613538, 6);
  });
  it('along/cross are correct for points ahead of and right of the threshold', () => {
    const ahead = destinationPoint(end28R.threshold, 298, 500);
    const r = relativeToRunway(ahead, end28R);
    expect(r.alongM).toBeCloseTo(500, 0);
    expect(Math.abs(r.crossM)).toBeLessThan(0.5);
    const right = destinationPoint(end28R.threshold, 298 + 90, 20);
    expect(relativeToRunway(right, end28R).crossM).toBeCloseTo(20, 0);
  });
  it('matches the runway by position and track, not the reciprocal', () => {
    const p = destinationPoint(end28R.threshold, 298, 400);
    const m = matchRunwayEnd(p, 299, [KSFO]);
    expect(m?.end.ident).toBe('28R');
    const m2 = matchRunwayEnd(p, 118, [KSFO]);
    expect(m2?.end.ident).toBe('10L');
    expect(matchRunwayEnd(p, 30, [KSFO])).toBeNull(); // crossing, not aligned
  });
  it('aim point by runway length', () => {
    expect(aimPointM(3618)).toBe(305);
    expect(aimPointM(1500)).toBe(150);
  });
});

describe('landingScore', () => {
  const rwy = { widthM: 61, lengthM: 3618, aimPointM: 305 };
  it('a perfect landing scores ~10 000 and is a butter', () => {
    const s = scoreLanding({ verticalSpeedMs: -50 * FPM, peakG: 1.05, lateralOffsetM: 0, alongTrackM: 305, lateralDriftMs: 0, crabDeg: 0, offRunway: false, bounces: 0 }, { stopDistanceM: 0.01, stopped: true }, rwy);
    expect(s.score).toBeGreaterThan(9900);
    expect(s.grade).toBe('Butter');
  });
  it('weights add to 1 and each term is bounded', () => {
    const s = scoreLanding({ verticalSpeedMs: -330 * FPM, peakG: 1.4, lateralOffsetM: 15.25, alongTrackM: 455, lateralDriftMs: 0, crabDeg: 0, offRunway: false, bounces: 0 }, { stopDistanceM: (3618 - 455) / 2, stopped: true }, rwy);
    expect(s.centre).toBeCloseTo(0.5, 6);
    expect(s.smooth).toBeCloseTo(0.5, 6);
    expect(s.zone).toBeCloseTo(0.5, 6);
    expect(s.stop).toBeCloseTo(0.5, 2);
    expect(s.score).toBeCloseTo(5000, -1);
    expect(s.grade).toBe('Firm');
  });
  it('crash conditions zero the score', () => {
    const hard = scoreLanding({ verticalSpeedMs: -1500 * FPM, peakG: 2, lateralOffsetM: 0, alongTrackM: 305, lateralDriftMs: 0, crabDeg: 0, offRunway: false, bounces: 0 }, { stopDistanceM: 500, stopped: true }, rwy);
    expect(hard.score).toBe(0);
    expect(hard.crashed).toBe(true);
    const off = scoreLanding({ verticalSpeedMs: -100 * FPM, peakG: 1.1, lateralOffsetM: 40, alongTrackM: 305, lateralDriftMs: 0, crabDeg: 0, offRunway: true, bounces: 0 }, { stopDistanceM: 500, stopped: true }, rwy);
    expect(off.score).toBe(0);
  });
});

/** Drive a synthetic approach and rollout on 28R. */
function simulateLanding(vsFpm: number, crossM: number, touchAlongM: number, stopAfterM: number) {
  const events = new EventBus();
  const got: { touch?: SimEvents['aircraft:touchdown']; score?: SimEvents['landing:scored']; liftoff?: number } = {};
  events.on('aircraft:touchdown', (e) => { got.touch = e; });
  events.on('landing:scored', (e) => { got.score = e; });
  events.on('aircraft:liftoff', () => { got.liftoff = (got.liftoff ?? 0) + 1; });
  const det = new TouchdownDetector(events, { airports: () => [KSFO] });
  det.reset(false);
  const dt = 1 / 120;
  const trk = (298 * Math.PI) / 180;
  const v = 60 * KT;
  const vs = vsFpm * FPM;
  // 10 s of final ending at the touchdown point
  for (let i = 0; i <= 1200; i++) {
    const t = i * dt;
    const along = touchAlongM - v * (10 - t);
    const c = destinationPoint(destinationPoint(end28R.threshold, 298, along), 298 + 90, crossM);
    const s: AircraftState = makeAircraftState({
      t, geo: c, onGround: i === 1200, altitudeAglM: i === 1200 ? 0.5 : Math.max(-vs * (10 - t), 0.6) + 0.5,
      verticalSpeedMs: vs, groundSpeedMs: v, trackRad: trk, headingTrueRad: trk,
      velNED: [Math.cos(trk) * v, Math.sin(trk) * v, -vs], loadFactor: [0, 0, 1.1],
    });
    det.step(dt, s);
  }
  // rollout with constant deceleration to stop after stopAfterM
  const decel = (v * v) / (2 * stopAfterM);
  let speed = v, along = touchAlongM;
  for (let i = 0; i < 120 * 120 && speed > 0; i++) {
    speed = Math.max(0, speed - decel * dt);
    along += speed * dt;
    const c = destinationPoint(destinationPoint(end28R.threshold, 298, along), 298 + 90, crossM);
    det.step(dt, makeAircraftState({ geo: c, onGround: true, groundSpeedMs: speed, trackRad: trk, headingTrueRad: trk, velNED: [Math.cos(trk) * speed, Math.sin(trk) * speed, 0], verticalSpeedMs: 0, altitudeAglM: 0.5 }));
  }
  return got;
}

describe('TouchdownDetector', () => {
  it('detects a touchdown on 28R and scores the rollout', () => {
    const got = simulateLanding(-120, 2, 320, 450);
    expect(got.touch).toBeDefined();
    expect(got.touch!.runway).toBe('KSFO 28R');
    expect(got.touch!.verticalSpeedMs).toBeCloseTo(-120 * FPM, 3);
    expect(got.touch!.centerlineOffsetM!).toBeCloseTo(2, 0);
    expect(got.score).toBeDefined();
    expect(got.score!.details.runway).toBe('KSFO 28R');
    expect(Number(got.score!.details.stopDistanceM)).toBeGreaterThan(420);
    expect(Number(got.score!.details.stopDistanceM)).toBeLessThan(480);
    expect(got.score!.score).toBeGreaterThan(7000);
  });
  it('a better landing scores higher than a worse one', () => {
    const good = simulateLanding(-80, 0.5, 305, 600).score!.score;
    const bad = simulateLanding(-500, 20, 900, 1500).score!.score;
    expect(good).toBeGreaterThan(bad);
  });
  it('emits liftoff once after a takeoff roll', () => {
    const events = new EventBus();
    let n = 0;
    events.on('aircraft:liftoff', () => n++);
    const det = new TouchdownDetector(events, { airports: () => [KSFO] });
    det.reset(true);
    for (let i = 0; i < 600; i++) det.step(1 / 120, makeAircraftState({ onGround: i < 120, altitudeAglM: i < 120 ? 0.5 : (i - 120) * 0.05 }));
    expect(n).toBe(1);
  });
});

describe('ReplayRecorder', () => {
  it('records at 30 Hz into a fixed ring and interpolates', () => {
    const rec = new ReplayRecorder(10, 30);
    expect(rec.capacity).toBe(300);
    const u = defaultControlInputs();
    for (let i = 0; i < 120 * 20; i++) {
      const t = i / 120;
      rec.record(1 / 120, makeAircraftState({ t, posNED: [t * 50, 0, -100], qNB: [1, 0, 0, 0] }), u);
    }
    expect(rec.length).toBe(300); // ring full after 20 s at 30 Hz with a 10 s window
    expect(rec.durationS).toBeGreaterThan(9.8);
    expect(rec.durationS).toBeLessThan(10.01);
    const f = emptyReplayFrame();
    expect(rec.sample(15, f)).toBe(true);
    expect(f.posNED[0]).toBeCloseTo(750, 0);
    rec.sample(-5, f); // clamps to the start
    expect(f.t).toBeCloseTo(rec.startTime, 9);
    expect(rec.bytes).toBeLessThan(2_000_000);
  });
  it('5 minutes at 30 Hz stays under ~2 MB', () => {
    expect(new ReplayRecorder(300, 30).bytes).toBeLessThan(2_000_000);
  });
});

describe('landing challenges', () => {
  it('every challenge has a valid airport and runway in the bundled data', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    type Rec = { i: string; r?: { id: string }[] };
    const load = (f: string) => (JSON.parse(readFileSync(f, 'utf8')) as { airports: Rec[] }).airports;
    const all: Rec[] = [...load('public/data/airports.json'), ...readdirSync('public/data/small').flatMap((f) => load(`public/data/small/${f}`))];
    for (const c of LANDING_CHALLENGES) {
      const ap = all.find((a) => a.i === c.icao);
      expect(ap, c.icao).toBeDefined();
      const ends = (ap!.r ?? []).flatMap((r) => r.id.split('/'));
      expect(ends, `${c.icao} ${c.runway}`).toContain(c.runway);
    }
  });
});
