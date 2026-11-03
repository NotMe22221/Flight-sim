import { describe, expect, it } from 'vitest';
import { LESSONS } from '../activities/lessons';
import { BUSH_TRIPS, PACIFIC_COAST, legDistanceNm, legRouteNm, navLog } from '../activities/bushTrips';
import { ActivityRunner, ProgressStore, type ActivityResult } from '../activities';
import type { ActivityProgressView, ActivityRunnerView, UnitsSettings } from './UiHost';
import {
  courseText, debriefVm, finishPresentation, finishToastText, formatDuration, lessonCard, lessonCards, legRow, legRows, objectiveRow,
  objectivesVm, progressPct, speakerFor, subtitleDurationMs, tripCard, tripCards, type ProgressPayload,
} from './activityModels';

const KM: UnitsSettings = { altitude: 'm', speed: 'kmh', pressure: 'hPa', distance: 'km', temperature: 'C' };
const memStore = () => new ProgressStore(null);

// compile-time: the real runner and store satisfy the UI's read-only views (SimUiHost hands them out)
const asRunnerView = (r: ActivityRunner): ActivityRunnerView => r;
const asProgressView = (p: ProgressStore): ActivityProgressView => p;
void asRunnerView; void asProgressView;

describe('lesson cards', () => {
  it('builds one card per lesson with the lesson plan', () => {
    const cards = lessonCards(LESSONS, null);
    expect(cards.map((c) => c.id)).toEqual(LESSONS.map((l) => l.id));
    for (const [i, c] of cards.entries()) {
      expect(c.steps).toEqual(LESSONS[i].steps.map((s) => s.title));
      expect(c.meta).toContain(`${LESSONS[i].steps.length} steps`);
      expect(c.status).toBe('Not flown yet');
      expect(c.completed).toBe(false);
      expect(c.bestScore).toBeNull();
      expect(c.duration).toBeNull();
      expect(c.difficulty).toBeNull();
    }
  });
  it('describes air and runway starts in the user units', () => {
    const basic = LESSONS.find((l) => l.id === 'lesson-basic-flight')!;
    const takeoff = LESSONS.find((l) => l.id === 'lesson-takeoff')!;
    expect(lessonCard(basic, null).start).toBe('In the air · 3,000 ft · 100 kt');
    expect(lessonCard(basic, null, KM).start).toBe('In the air · 910 m · 185 km/h');
    expect(lessonCard(takeoff, null).start).toBe('Lined up on KSFO runway 28R');
    expect(lessonCard(basic, null).weather).toBe('Clear skies');
    expect(lessonCard(basic, null).time).toBe('Morning');
  });
  it('shows completed badges, best scores and attempts from the progress store', () => {
    const p = memStore();
    p.recordLessonAttempt('lesson-basic-flight');
    p.completeLesson('lesson-basic-flight', 87.4);
    p.recordLessonAttempt('lesson-takeoff');
    p.recordLessonAttempt('lesson-takeoff');
    const [basic, takeoff, landing] = lessonCards(LESSONS, p);
    expect(basic.completed).toBe(true);
    expect(basic.bestScore).toBe(87);
    expect(basic.status).toBe('Completed · best 87/100 · Good');
    expect(takeoff.completed).toBe(false);
    expect(takeoff.status).toBe('2 attempts · not completed yet');
    expect(landing.status).toBe('Not flown yet');
  });
  it('reads optional duration / difficulty metadata when a lesson has it', () => {
    const vm = lessonCard({ ...LESSONS[0], durationMin: 12.4, difficulty: 'beginner' } as typeof LESSONS[0], null);
    expect(vm.duration).toBe('~12 min');
    expect(vm.difficulty).toBe('Beginner');
  });
  it('survives a throwing progress store', () => {
    const bad = { lesson: () => { throw new Error('boom'); } } as unknown as ProgressStore;
    expect(lessonCard(LESSONS[0], bad).status).toBe('Not flown yet');
  });
});

describe('trip cards', () => {
  const trip = PACIFIC_COAST;
  const n = trip.legs.length;
  it('starts with nothing flown', () => {
    const vm = tripCard(trip, memStore());
    expect(vm).toMatchObject({ legCount: n, completedLegs: 0, nextLeg: 0, done: false, status: 'Not started', resumeLabel: 'Start trip', ends: 'KHAF → KSBA' });
    expect(vm.fraction).toBe(0);
    let total = 0;
    for (let i = 0; i < n; i++) total += legRouteNm(trip, i);
    expect(vm.totalNm).toBeCloseTo(total, 6);
    expect(tripCards(BUSH_TRIPS, null).length).toBe(BUSH_TRIPS.length);
  });
  it('counts completed legs and resumes at the first incomplete one', () => {
    const p = memStore();
    for (let i = 0; i < 3; i++) p.completeLeg(trip.id, i, { score: 80 });
    const vm = tripCard(trip, p);
    expect(vm).toMatchObject({ completedLegs: 3, nextLeg: 3, done: false, status: `3 / ${n} legs`, resumeLabel: 'Resume · leg 4' });
    expect(vm.fraction).toBeCloseTo(3 / n, 9);
  });
  it('reports a finished trip', () => {
    const p = memStore();
    for (let i = 0; i < n; i++) p.completeLeg(trip.id, i, { score: 90 });
    expect(tripCard(trip, p)).toMatchObject({ completedLegs: n, nextLeg: n, done: true, status: 'Trip complete', resumeLabel: 'Fly again', fraction: 1 });
  });
});

describe('leg list', () => {
  const trip = PACIFIC_COAST;
  it('marks completed, next and locked legs', () => {
    const p = memStore();
    p.completeLeg(trip.id, 0, { score: 92.2, landingScore: 8450 });
    p.completeLeg(trip.id, 1, { score: 70 });
    const rows = legRows(trip, p);
    expect(rows.map((r) => r.status)).toEqual(['completed', 'completed', 'next', ...Array(trip.legs.length - 3).fill('locked')]);
    expect(rows.map((r) => r.unlocked)).toEqual([true, true, true, ...Array(trip.legs.length - 3).fill(false)]);
    expect(rows[0].statusText).toBe('Completed · best 92/100');
    expect(rows[0].bestLandingScore).toBe(8450);
    expect(rows[2].statusText).toBe('Next leg');
    expect(rows[3].statusText).toBe('Locked: complete leg 3 first');
  });
  it('opens every leg when the host keeps no progress', () => {
    const rows = legRows(trip, null);
    expect(rows[0].status).toBe('next');
    expect(rows.slice(1).every((r) => r.status === 'unlocked' && r.unlocked)).toBe(true);
  });
  it('describes a leg: route, distances, cruise, landmarks, terrain, nav log', () => {
    const r = legRow(trip, 0, memStore());
    const leg = trip.legs[0];
    expect(r).toMatchObject({ label: 'Leg 1', from: 'KHAF', to: 'KRHV', title: 'KHAF → KRHV', fromName: 'Half Moon Bay', cruiseFt: 3500, cruise: '3,500 ft', departureRunway: '30' });
    expect(r.landmarks).toEqual(leg.waypoints.map((w) => w.name));
    expect(r.terrain).toBe('Skyline ridge near Kings Mountain · 2,400 ft');
    expect(r.routeNm).toBeCloseTo(legRouteNm(trip, 0), 9);
    expect(r.directNm).toBeCloseTo(legDistanceNm(trip, 0), 9);
    expect(r.distance).toBe(`${r.routeNm.toFixed(0)} nm via landmarks · ${r.directNm.toFixed(0)} nm direct`);
    expect(r.segments.length).toBe(leg.waypoints.length + 1);
    expect(r.segments[0].from).toBe('KHAF');
    expect(r.segments[r.segments.length - 1].to).toBe('KRHV');
    expect(r.segments[0].course).toMatch(/^\d{3}°T$/);
    expect(r.weather).toBe('Few clouds');
    expect(r.time).toBe('Morning');
  });
  it('follows the unit settings and the magnetic variation', () => {
    const r = legRow(trip, 1, null, KM, 13);
    expect(r.cruise).toBe('1,680 m'); // 5,500 ft
    expect(r.terrain).toBe('Loma Prieta · 1,150 m');
    expect(r.distanceShort).toMatch(/ km$/);
    const trueCourse = navLog(trip, 1)[0].trueCourseDeg;
    expect(r.segments[0].course).toBe(courseText(trueCourse, 13));
    expect(r.segments[0].course.endsWith('T')).toBe(false);
  });
  it('formats courses aviation style', () => {
    expect(courseText(0)).toBe('360°T');
    expect(courseText(5.4)).toBe('005°T');
    expect(courseText(100, 13)).toBe('087°');
    expect(courseText(5, 13)).toBe('352°');
    expect(courseText(Number.NaN)).toBe('---°');
  });
});

describe('objectives panel model', () => {
  const def = LESSONS.find((l) => l.id === 'lesson-basic-flight')!;
  const payload = (step: number): ProgressPayload => ({
    id: def.id, step,
    objectives: def.steps.flatMap((s, si) => s.objectives.map((o) => ({
      text: o.label, step: si, optional: !!o.optional, progress: si < step ? 1 : si === step ? 0.42 : 0,
      status: si < step ? 'done' as const : si === step ? 'active' as const : 'pending' as const,
    }))),
  });
  it('shows the current step only, with its title and what comes next', () => {
    const vm = objectivesVm(payload(1), def);
    expect(vm.step).toBe(1);
    expect(vm.stepLabel).toBe(`Step 2 of ${def.steps.length}`);
    expect(vm.stepTitle).toBe(def.steps[1].title);
    expect(vm.next).toBe(`Next: ${def.steps[2].title}`);
    expect(vm.rows.map((r) => r.text)).toEqual(def.steps[1].objectives.map((o) => o.label));
    expect(vm.rows.every((r) => r.status === 'active' && r.icon === 'circleDot' && r.progress === 0.42)).toBe(true);
    const required = def.steps.flatMap((s) => s.objectives.filter((o) => !o.optional));
    expect(vm.totalCount).toBe(required.length);
    expect(vm.doneCount).toBe(def.steps[0].objectives.filter((o) => !o.optional).length);
  });
  it('has no "next" on the last step and counts steps without a definition', () => {
    expect(objectivesVm(payload(def.steps.length - 1), def).next).toBeNull();
    const bare = objectivesVm({ id: 'x', step: 0, objectives: [{ text: 'A', status: 'active' }, { text: 'B', status: 'pending' }] });
    expect(bare.rows.length).toBe(2); // entries without a step index belong to the current step
    expect(bare.stepLabel).toBe('Step 1 of 1');
    expect(bare.stepTitle).toBe('');
  });
  it('maps rows defensively (unknown status, out-of-range progress, done = full bar)', () => {
    expect(objectiveRow({ text: 'x', status: 'weird' })).toMatchObject({ status: 'pending', icon: 'circle', progress: 0 });
    expect(objectiveRow({ text: 'x', status: 'active', progress: 3 }).progress).toBe(1);
    expect(objectiveRow({ text: 'x', status: 'done', progress: 0.2 }).progress).toBe(1);
    expect(objectiveRow({ label: 'from a view', state: 'failed', optional: true })).toMatchObject({ text: 'from a view', status: 'failed', optional: true, icon: 'circleX' });
    expect(progressPct(0.456)).toBe(46);
    expect(progressPct(Number.NaN)).toBe(0);
  });
  it('times subtitles: ~6 s, 9 s when important, longer lines read longer, capped', () => {
    expect(subtitleDurationMs('Level the wings.')).toBe(6000);
    expect(subtitleDurationMs('Level the wings.', true)).toBe(9000);
    expect(subtitleDurationMs('x'.repeat(200))).toBe(12000);
    expect(subtitleDurationMs('x'.repeat(5000), true)).toBe(25000);
    expect(speakerFor('bushTrip')).toBe('Co-pilot');
    expect(speakerFor('lesson')).toBe('Instructor');
  });
});

describe('debrief', () => {
  const base = (over: Partial<ActivityResult>): ActivityResult => ({
    id: 'pacific-coast-leg1', kind: 'bushTrip', title: 'Pacific Coast: leg 1, KHAF to KRHV', success: true, score: 83, grade: 'Good',
    summary: 'Leg complete.', reason: null, durationS: 1530, fuelKg: 95, landingScore: 7840,
    steps: [
      { id: 'depart', title: 'Depart KHAF runway 30', score: 100, completed: true, objectives: [{ label: 'Take off', state: 'done', optional: false, score: 1, note: null }] },
      { id: 'enroute', title: 'Fly to Reid-Hillview', score: 66, completed: true, objectives: [
        { label: 'Overfly Crystal Springs Dam', state: 'done', optional: true, score: 1, note: null },
        { label: 'Overfly Hoover Tower', state: 'failed', optional: true, score: 0, note: 'Missed' },
        { label: 'Land and stop', state: 'done', optional: false, score: 1, note: null },
      ] },
    ],
    ...over,
  });
  const def = { trip: { tripId: 'pacific-coast', legIndex: 0 } };
  it('offers the next leg once it is unlocked', () => {
    const p = memStore();
    p.completeLeg('pacific-coast', 0, { score: 83 });
    const vm = debriefVm(base({}), def, BUSH_TRIPS, p);
    expect(vm.headline).toBe('Leg complete');
    expect(vm.kindLabel).toBe('Bush trip');
    expect(vm.nextLeg).toEqual({ tripId: 'pacific-coast', legIndex: 1, label: 'Next leg: KRHV → KWVI' });
    expect(vm.duration).toBe('25 min 30 s');
    expect(vm.landing).toEqual({ score: 7840, text: '7,840 · Great landing' });
    expect(vm.fuelKg).toBe(95);
    const objs = vm.steps[1].objectives;
    expect(objs.map((o) => o.cls)).toEqual(['ok', 'missed', 'ok']);
    expect(objs[1].icon).toBe('circle');
  });
  it('does not offer a locked or non-existent next leg', () => {
    expect(debriefVm(base({ success: false, reason: 'Crash: hit terrain' }), def, BUSH_TRIPS, memStore()).nextLeg).toBeNull();
    const last = { trip: { tripId: 'pacific-coast', legIndex: PACIFIC_COAST.legs.length - 1 } };
    expect(debriefVm(base({}), last, BUSH_TRIPS, null).nextLeg).toBeNull();
    // no store: after a success the next leg is offered
    expect(debriefVm(base({}), def, BUSH_TRIPS, null).nextLeg?.legIndex).toBe(1);
  });
  it('explains a failed lesson', () => {
    const r = base({
      id: 'lesson-takeoff', kind: 'lesson', title: 'Takeoff', success: false, grade: 'Incomplete', score: 41, landingScore: null, fuelKg: 140,
      reason: 'Drifted off the centreline',
      steps: [{ id: 'roll', title: 'Takeoff roll', score: 20, completed: false, objectives: [
        { label: 'Keep the centreline', state: 'failed', optional: false, score: 0, note: 'Drifted off the centreline' },
        { label: 'Rotate at 55 KIAS', state: 'pending', optional: false, score: 0, note: null },
      ] }],
    });
    const vm = debriefVm(r, null, BUSH_TRIPS, null);
    expect(vm).toMatchObject({ headline: 'Lesson not completed', kindLabel: 'Flight training', reason: 'Drifted off the centreline', landing: null, fuelKg: null, nextLeg: null });
    expect(vm.steps[0].objectives.map((o) => [o.cls, o.note])).toEqual([['err', 'Drifted off the centreline'], ['pending', 'Not reached']]);
  });
  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(120)).toBe('2 min');
    expect(formatDuration(3725)).toBe('1 h 02 min');
    expect(formatDuration(-1)).toBe('--');
  });
});

describe('finish presentation', () => {
  it('shows a debrief for completed, failed and crashed activities', () => {
    expect(finishPresentation({ replacing: false, userAborted: false, reason: null })).toBe('debrief');
    expect(finishPresentation({ replacing: false, userAborted: false, reason: 'Crash: hit terrain' })).toBe('debrief');
  });
  it('shows nothing when another activity takes over', () => {
    expect(finishPresentation({ replacing: true, userAborted: false, reason: 'Aborted' })).toBe('none');
    expect(finishPresentation({ replacing: false, userAborted: false, reason: 'Replaced by another activity' })).toBe('none');
  });
  it('toasts an abort and a changed flight', () => {
    expect(finishPresentation({ replacing: false, userAborted: true, reason: 'Aborted' })).toBe('toast');
    expect(finishPresentation({ replacing: false, userAborted: false, reason: 'Flight changed' })).toBe('toast');
    expect(finishToastText('lesson', 'Takeoff', 'Aborted')).toBe('Lesson aborted · you are in free flight');
    expect(finishToastText('bushTrip', 'Leg 1', 'Flight changed')).toBe('Bush leg ended: the flight changed (Leg 1)');
  });
});
