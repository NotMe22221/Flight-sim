/**
 * Activities › Flight training / Bush trips and the in-flight objectives panel and debrief, view
 * side. Pure functions over the activity data (src/activities: LESSONS, BUSH_TRIPS, navLog …),
 * the saved progress and the runner's events/result; the DOM classes only render what these
 * return, so everything here is unit-tested in Node.
 */
import type { ActivityDef, ActivityResult } from '../activities/activityTypes';
import type { ObjectiveState } from '../activities/objectives';
import { gradeFor } from '../activities/activityTypes';
import { legDistanceNm, legRouteNm, navLog, type BushTrip } from '../activities/bushTrips';
import type { ActivityProgressView, UnitsSettings } from './UiHost';
import type { IconName } from './icons';
import { FT_PER_M, KT_PER_MS, defaultUnits, formatAltitude, formatDistance, formatSpeed, groupThousands, normalizeHeading } from './format';
import { scoreBand } from './landingReportModel';
import { weatherPresetLabel } from './weatherPresets';

/** The progress store, or null when the host has none (nothing is saved: every leg is open). */
export type ProgressLike = Pick<ActivityProgressView, 'isLegUnlocked' | 'isLegCompleted' | 'nextLeg' | 'completedLegs' | 'leg' | 'lesson'> | null | undefined;

const NM_M = 1852;
const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Read a store call defensively: a throwing host must never break a menu. */
function safe<T>(f: () => T, fallback: T): T { try { return f(); } catch { return fallback; } }

export const altText = (ft: number, u: UnitsSettings = defaultUnits): string => formatAltitude(ft / FT_PER_M, u, u.altitude === 'ft' ? 1 : 10);
export const nmText = (nm: number, u: UnitsSettings = defaultUnits): string => formatDistance(nm * NM_M, u);
/** '87/100' */
export const scoreText = (score: number): string => `${Math.round(score)}/100`;

/** '45 s', '6 min 20 s', '1 h 05 min'. */
export function formatDuration(s: number): string {
  if (!finite(s) || s < 0) return '--';
  const t = Math.round(s);
  if (t < 60) return `${t} s`;
  const m = Math.floor(t / 60), sec = t % 60;
  if (m < 60) return sec ? `${m} min ${sec} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// ─── Flight training ──────────────────────────────────────────────────────────

export interface LessonCardVm {
  id: string;
  title: string;
  description: string;
  /** '7 steps · In the air · Clear · Morning' */
  meta: string;
  /** how the lesson starts: 'In the air · 3,000 ft · 100 kt' / 'Lined up on KSFO runway 28R' */
  start: string;
  weather: string;
  time: string;
  /** authored metadata when the lesson has it (none of the bundled lessons do yet) */
  duration: string | null;
  difficulty: string | null;
  completed: boolean;
  /** 0..100 once completed */
  bestScore: number | null;
  attempts: number;
  /** 'Completed · best 87/100 · Good', '2 attempts · not completed yet', 'Not flown yet' */
  status: string;
  /** the lesson plan: one title per step */
  steps: string[];
}

/** Optional authoring fields a lesson may carry (read defensively). */
type LessonExtras = { durationMin?: unknown; difficulty?: unknown };

function startText(def: ActivityDef, u: UnitsSettings): string {
  const s = def.setup;
  if (s.spawn === 'air') return `In the air · ${altText(s.altFt, u)} · ${formatSpeed(s.iasKt / KT_PER_MS, u)}`;
  return `${s.coldAndDark ? 'Cold and dark at' : 'Lined up on'} ${s.icao} runway ${s.runway}`;
}

export function lessonCard(def: ActivityDef, progress: ProgressLike, u: UnitsSettings = defaultUnits): LessonCardVm {
  const rec = progress ? safe(() => progress.lesson(def.id), null) : null;
  const extras = def as ActivityDef & LessonExtras;
  const completed = rec?.completed === true;
  const attempts = rec && finite(rec.attempts) ? rec.attempts : 0;
  const bestScore = completed && rec && finite(rec.bestScore) ? Math.round(rec.bestScore) : null;
  const weather = def.setup.weather ? weatherPresetLabel(def.setup.weather) : 'Current weather';
  const time = def.setup.time ? cap(def.setup.time) : 'Current time';
  const status = completed
    ? `Completed · best ${scoreText(bestScore ?? 0)} · ${gradeFor(bestScore ?? 0, true)}`
    : attempts > 0 ? `${attempts} attempt${attempts === 1 ? '' : 's'} · not completed yet` : 'Not flown yet';
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    meta: [`${def.steps.length} step${def.steps.length === 1 ? '' : 's'}`, def.setup.spawn === 'air' ? 'In the air' : `${def.setup.icao} ${def.setup.runway}`, weather, time].join(' · '),
    start: startText(def, u),
    weather,
    time,
    duration: finite(extras.durationMin) && extras.durationMin > 0 ? `~${Math.round(extras.durationMin)} min` : null,
    difficulty: typeof extras.difficulty === 'string' && extras.difficulty ? cap(extras.difficulty) : null,
    completed,
    bestScore,
    attempts,
    status,
    steps: def.steps.map((st) => st.title),
  };
}

export function lessonCards(lessons: readonly ActivityDef[], progress: ProgressLike, u: UnitsSettings = defaultUnits): LessonCardVm[] {
  return lessons.map((l) => lessonCard(l, progress, u));
}

// ─── Bush trips ───────────────────────────────────────────────────────────────

export interface TripCardVm {
  id: string;
  title: string;
  region: string;
  description: string;
  legCount: number;
  completedLegs: number;
  /** 0..1 */
  fraction: number;
  /** total distance through the landmarks, nm */
  totalNm: number;
  /** index of the leg to resume (legCount when the trip is done) */
  nextLeg: number;
  done: boolean;
  /** 'KHAF → KSBA' */
  ends: string;
  /** '3 / 8 legs', 'Trip complete', 'Not started' */
  status: string;
  /** primary action label: 'Start trip', 'Resume · leg 4', 'Fly again' */
  resumeLabel: string;
}

function nextLegOf(trip: BushTrip, progress: ProgressLike): number {
  if (!progress) return 0;
  const n = safe(() => progress.nextLeg(trip.id, trip.legs.length), 0);
  return finite(n) ? Math.min(Math.max(0, Math.floor(n)), trip.legs.length) : 0;
}

export function tripCard(trip: BushTrip, progress: ProgressLike): TripCardVm {
  const legCount = trip.legs.length;
  let completed = 0;
  for (let i = 0; i < legCount; i++) if (progress && safe(() => progress.isLegCompleted(trip.id, i), false)) completed++;
  const next = nextLegOf(trip, progress);
  const done = legCount > 0 && completed >= legCount;
  let totalNm = 0;
  for (let i = 0; i < legCount; i++) totalNm += legRouteNm(trip, i);
  const first = trip.legs[0], last = trip.legs[legCount - 1];
  return {
    id: trip.id,
    title: trip.title,
    region: trip.region,
    description: trip.description,
    legCount,
    completedLegs: completed,
    fraction: legCount ? completed / legCount : 0,
    totalNm,
    nextLeg: next,
    done,
    ends: first && last ? `${first.from} → ${last.to}` : '',
    status: done ? 'Trip complete' : completed ? `${completed} / ${legCount} legs` : 'Not started',
    resumeLabel: done ? 'Fly again' : completed || next > 0 ? `Resume · leg ${next + 1}` : 'Start trip',
  };
}

export function tripCards(trips: readonly BushTrip[], progress: ProgressLike): TripCardVm[] {
  return trips.map((t) => tripCard(t, progress));
}

export type LegStatus = 'completed' | 'next' | 'unlocked' | 'locked';

export interface LegSegmentVm { from: string; to: string; course: string; distance: string }

export interface LegRowVm {
  index: number;
  /** 'Leg 3' */
  label: string;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  /** 'KWVI → KMRY' */
  title: string;
  routeNm: number;
  directNm: number;
  /** '25.6 nm via landmarks · 21.1 nm direct' */
  distance: string;
  /** '25.6 nm' */
  distanceShort: string;
  cruiseFt: number;
  cruise: string;
  departureRunway: string;
  landmarks: string[];
  /** 'Jacks Peak · 1,068 ft' */
  terrain: string;
  weather: string;
  time: string;
  briefing: string;
  segments: LegSegmentVm[];
  status: LegStatus;
  unlocked: boolean;
  completed: boolean;
  /** 0..100 */
  bestScore: number | null;
  /** 0..10 000 */
  bestLandingScore: number | null;
  attempts: number;
  /** 'Completed · best 92/100', 'Next leg', 'Locked: complete leg 2 first' */
  statusText: string;
}

/** Course for the leg briefing: magnetic when the variation is known (as charts and the compass), else marked 'T'. */
export function courseText(trueDeg: number, magVarDeg?: number | null): string {
  if (!finite(trueDeg)) return '---°';
  const mag = finite(magVarDeg);
  const v = normalizeHeading(Math.round(mag ? trueDeg - (magVarDeg as number) : trueDeg));
  return `${String(v === 0 ? 360 : v).padStart(3, '0')}°${mag ? '' : 'T'}`;
}

export function legRow(trip: BushTrip, index: number, progress: ProgressLike, u: UnitsSettings = defaultUnits, magVarDeg?: number | null): LegRowVm {
  const leg = trip.legs[index];
  const from = trip.airports[leg.from], to = trip.airports[leg.to];
  const routeNm = legRouteNm(trip, index), directNm = legDistanceNm(trip, index);
  const rec = progress ? safe(() => progress.leg(trip.id, index), null) : null;
  const completed = progress ? safe(() => progress.isLegCompleted(trip.id, index), false) : false;
  // without a progress store nothing is saved, so locking would make later legs unreachable
  const unlocked = progress ? safe(() => progress.isLegUnlocked(trip.id, index), index === 0) : true;
  const next = nextLegOf(trip, progress);
  const status: LegStatus = completed ? 'completed' : index === next ? 'next' : unlocked ? 'unlocked' : 'locked';
  const bestScore = completed && rec && finite(rec.bestScore) ? Math.round(rec.bestScore) : null;
  const bestLandingScore = rec && finite(rec.bestLandingScore) ? Math.round(rec.bestLandingScore) : null;
  const statusText = status === 'completed' ? `Completed${bestScore !== null ? ` · best ${scoreText(bestScore)}` : ''}`
    : status === 'next' ? 'Next leg' : status === 'unlocked' ? 'Open' : `Locked: complete leg ${index} first`;
  return {
    index,
    label: `Leg ${index + 1}`,
    from: leg.from,
    to: leg.to,
    fromName: from?.name ?? leg.from,
    toName: to?.name ?? leg.to,
    title: `${leg.from} → ${leg.to}`,
    routeNm,
    directNm,
    distance: `${nmText(routeNm, u)} via landmarks · ${nmText(directNm, u)} direct`,
    distanceShort: nmText(routeNm, u),
    cruiseFt: leg.cruiseFt,
    cruise: altText(leg.cruiseFt, u),
    departureRunway: leg.departureRunway,
    landmarks: leg.waypoints.map((w) => w.name),
    terrain: `${cap(leg.terrain.name.replace(/^the /, ''))} · ${altText(leg.terrain.ft, u)}`,
    weather: weatherPresetLabel(leg.weather ?? 'few'),
    time: cap(leg.time ?? 'morning'),
    briefing: leg.briefing.text,
    segments: navLog(trip, index).map((e) => ({ from: e.from, to: e.to, course: courseText(e.trueCourseDeg, magVarDeg), distance: nmText(e.distanceNm, u) })),
    status,
    unlocked: unlocked || completed,
    completed,
    bestScore,
    bestLandingScore,
    attempts: rec && finite(rec.attempts) ? rec.attempts : 0,
    statusText,
  };
}

export function legRows(trip: BushTrip, progress: ProgressLike, u: UnitsSettings = defaultUnits, magVarDeg?: number | null): LegRowVm[] {
  return trip.legs.map((_, i) => legRow(trip, i, progress, u, magVarDeg));
}

/** The landing score for a card: '8,450 · Great landing'. */
export function landingScoreText(score: number): string { return `${groupThousands(score)} · ${scoreBand(score)}`; }

// ─── In flight: objectives panel ──────────────────────────────────────────────

export type ObjStatus = ObjectiveState;

/** One 'activity:progress' entry (the runner adds step / optional / progress to the SimEvents shape). */
export interface ProgressEntry { text: string; status: ObjStatus; step?: number; optional?: boolean; progress?: number }
export interface ProgressPayload { id: string; step: number; objectives: readonly ProgressEntry[] }

export interface ObjectiveRowVm {
  text: string;
  status: ObjStatus;
  optional: boolean;
  /** 0..1 */
  progress: number;
  icon: IconName;
}

export interface ObjectivesVm {
  /** current step index (−1 before the first) */
  step: number;
  stepCount: number;
  /** 'Step 2 of 7' */
  stepLabel: string;
  stepTitle: string;
  rows: ObjectiveRowVm[];
  /** 'Next: Level off' */
  next: string | null;
  /** required objectives done over all steps (for an overall bar) */
  doneCount: number;
  totalCount: number;
}

export const STATUS_ICON: Record<ObjStatus, IconName> = { pending: 'circle', active: 'circleDot', done: 'circleCheck', failed: 'circleX' };

const clamp01 = (x: unknown): number => (finite(x) ? Math.min(1, Math.max(0, x)) : 0);
const isStatus = (s: unknown): s is ObjStatus => s === 'pending' || s === 'active' || s === 'done' || s === 'failed';

export function objectiveRow(e: { text?: unknown; label?: unknown; status?: unknown; state?: unknown; optional?: unknown; progress?: unknown }): ObjectiveRowVm {
  const raw = e.status ?? e.state;
  const status: ObjStatus = isStatus(raw) ? raw : 'pending';
  const text = typeof e.text === 'string' ? e.text : typeof e.label === 'string' ? e.label : '';
  return { text, status, optional: e.optional === true, progress: status === 'done' ? 1 : clamp01(e.progress), icon: STATUS_ICON[status] };
}

/**
 * The panel's view of an 'activity:progress' payload: the current step's objectives (entries
 * without a `step` index count as the current step), its title from the activity definition when
 * known, and what comes next.
 */
export function objectivesVm(p: ProgressPayload, def?: Pick<ActivityDef, 'steps'> | null): ObjectivesVm {
  const step = finite(p.step) ? Math.floor(p.step) : -1;
  const all = Array.isArray(p.objectives) ? p.objectives : [];
  let maxStep = -1;
  for (const e of all) if (finite(e.step)) maxStep = Math.max(maxStep, e.step);
  const stepCount = def?.steps.length ?? Math.max(maxStep + 1, step + 1, 1);
  const rows = all.filter((e) => !finite(e.step) || e.step === step).map(objectiveRow);
  const title = def?.steps[step]?.title ?? '';
  const nextTitle = def?.steps[step + 1]?.title ?? null;
  return {
    step,
    stepCount,
    stepLabel: step >= 0 ? `Step ${Math.min(step + 1, stepCount)} of ${stepCount}` : 'Getting ready',
    stepTitle: title,
    rows,
    next: nextTitle ? `Next: ${nextTitle}` : null,
    doneCount: all.filter((e) => e.optional !== true && e.status === 'done').length,
    totalCount: all.filter((e) => e.optional !== true).length,
  };
}

/** Progress bar width in whole percent (the DOM is written only when this changes). */
export const progressPct = (x: number): number => Math.round(clamp01(x) * 100);

// ─── In flight: instructor subtitles ──────────────────────────────────────────

export const SUBTITLE_MIN_MS = 6000;
export const SUBTITLE_IMPORTANT_MS = 9000;
export const SUBTITLE_MAX_MS = 25000;
/** reading time per character beyond the minimum */
export const SUBTITLE_MS_PER_CHAR = 60;

/** ~6 s (9 s when important), longer for long lines (60 ms per character), at most 25 s. */
export function subtitleDurationMs(text: string, important = false): number {
  const base = important ? SUBTITLE_IMPORTANT_MS : SUBTITLE_MIN_MS;
  return Math.min(SUBTITLE_MAX_MS, Math.max(base, (text?.length ?? 0) * SUBTITLE_MS_PER_CHAR));
}

/** Who speaks the activity lines. */
export const speakerFor = (kind: string | null | undefined): string => (kind === 'bushTrip' ? 'Co-pilot' : 'Instructor');

// ─── Debrief ──────────────────────────────────────────────────────────────────

export interface DebriefObjectiveVm { label: string; state: ObjStatus; optional: boolean; note: string | null; icon: IconName; cls: 'ok' | 'err' | 'missed' | 'pending' }
export interface DebriefStepVm { title: string; score: number; completed: boolean; objectives: DebriefObjectiveVm[] }

export interface DebriefVm {
  title: string;
  kindLabel: string;
  success: boolean;
  /** 'Lesson complete', 'Lesson not completed', 'Leg complete', 'Leg not completed' */
  headline: string;
  score: number;
  grade: string;
  summary: string;
  reason: string | null;
  duration: string;
  landing: { score: number; text: string } | null;
  /** fuel on board at the end, for bush legs ('112 kg' style comes from the caller's units) */
  fuelKg: number | null;
  steps: DebriefStepVm[];
  /** the next leg to offer (bush trips): unlocked and existing */
  nextLeg: { tripId: string; legIndex: number; label: string } | null;
}

function debriefObjective(o: ActivityResult['steps'][number]['objectives'][number]): DebriefObjectiveVm {
  const state: ObjStatus = isStatus(o.state) ? o.state : 'pending';
  const cls = state === 'done' ? 'ok' : state === 'failed' ? (o.optional ? 'missed' : 'err') : 'pending';
  const note = o.note ?? (state === 'pending' ? 'Not reached' : null);
  return { label: o.label, state, optional: o.optional, note, icon: cls === 'missed' ? 'circle' : STATUS_ICON[state], cls };
}

/**
 * Debrief card content from the runner's result. `trips` resolves the next leg of a bush trip; it
 * is offered when it exists and the progress store has unlocked it (no store: after a success).
 */
export function debriefVm(r: ActivityResult, def: Pick<ActivityDef, 'trip'> | null, trips: readonly BushTrip[], progress: ProgressLike): DebriefVm {
  const bush = r.kind === 'bushTrip';
  const what = bush ? 'Leg' : 'Lesson';
  let nextLeg: DebriefVm['nextLeg'] = null;
  const t = def?.trip;
  if (t) {
    const trip = trips.find((x) => x.id === t.tripId);
    const i = t.legIndex + 1;
    const open = progress ? safe(() => progress.isLegUnlocked(t.tripId, i), false) : r.success;
    if (trip && i < trip.legs.length && open) nextLeg = { tripId: trip.id, legIndex: i, label: `Next leg: ${trip.legs[i].from} → ${trip.legs[i].to}` };
  }
  return {
    title: r.title,
    kindLabel: bush ? 'Bush trip' : 'Flight training',
    success: r.success,
    headline: r.success ? `${what} complete` : `${what} not completed`,
    score: finite(r.score) ? Math.round(r.score) : 0,
    grade: r.grade,
    summary: r.summary,
    reason: r.success ? null : r.reason,
    duration: formatDuration(r.durationS),
    landing: finite(r.landingScore) ? { score: Math.round(r.landingScore), text: landingScoreText(r.landingScore) } : null,
    fuelKg: bush && finite(r.fuelKg) && r.fuelKg > 0 ? r.fuelKg : null,
    steps: r.steps.map((s) => ({ title: s.title, score: finite(s.score) ? Math.round(s.score) : 0, completed: s.completed, objectives: s.objectives.map(debriefObjective) })),
    nextLeg,
  };
}

/**
 * How an 'activity:finished' is presented: the debrief card, a toast, or nothing.
 *  - the UI is replacing the activity (Retry, another Start): nothing, the new one takes over
 *  - the pilot aborted it from the pause menu: a toast
 *  - the flight changed under it (a new free flight, another challenge): a toast
 *  - otherwise (completed, failed, crashed): the debrief
 */
export type FinishPresentation = 'debrief' | 'toast' | 'none';
export function finishPresentation(o: { replacing: boolean; userAborted: boolean; reason: string | null | undefined }): FinishPresentation {
  if (o.replacing || o.reason === 'Replaced by another activity') return 'none';
  if (o.userAborted || o.reason === 'Aborted' || o.reason === 'Flight changed') return 'toast';
  return 'debrief';
}

/** Toast for an activity that ended without a debrief. */
export function finishToastText(kind: string | null | undefined, title: string, reason: string | null | undefined): string {
  const what = kind === 'bushTrip' ? 'Bush leg' : 'Lesson';
  if (reason === 'Flight changed') return `${what} ended: the flight changed (${title})`;
  return `${what} aborted · you are in free flight`;
}
