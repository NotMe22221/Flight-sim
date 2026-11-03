/**
 * Activity definitions (lessons, bush-trip legs) and the ActivityHost contract the simulator
 * implements so the ActivityRunner can set up a flight. Everything here is plain data.
 */
import type { WeatherPresetId, Waypoint } from '../core/types';
import type { ConditionSpec, Line, ObjectiveSpec, ObjectiveState } from './objectives';

export type TimePreset = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'dusk' | 'night';

export interface RunwaySpawnOptions {
  /** engine off, master off */
  coldAndDark?: boolean;
  /** 0..1 of usable fuel */
  fuelFraction?: number;
  payloadKg?: number;
  /** set the parking brake once positioned (lessons that teach releasing it); default: the simulator's normal spawn state */
  parkingBrake?: boolean;
}

export interface AirSpawnOptions {
  /** index into the aircraft's flap detents */
  flapsIndex?: number;
  /** flight-path angle for the trim, rad (negative = descending) */
  gammaRad?: number;
}

/**
 * What an activity needs from the simulator. Spawns may be async; the runner awaits them and
 * ignores the 'flight:reset' they emit. The weather preset is applied before the spawn (runway
 * choice may depend on the wind); the time preset (sunrise-relative, so it needs the new
 * position) and the route after it.
 */
export interface ActivityHost {
  /** lined up on `runway` (landing-direction designator) at `icao`, engine running unless coldAndDark */
  spawnAtRunway(icao: string, runway: string, opts?: RunwaySpawnOptions): void | Promise<void>;
  /** trimmed in the air: true heading, indicated airspeed */
  spawnInAir(lat: number, lon: number, altM: number, headingDeg: number, iasMs: number, opts?: AirSpawnOptions): void | Promise<void>;
  setWeatherPreset(id: WeatherPresetId): void;
  setTimePreset(preset: TimePreset): void;
  /** load a VFR route (departure, landmarks, destination) into the flight plan / map */
  loadRoute(waypoints: Waypoint[]): void;
  /** remove the activity's route (called when an activity with a route ends) */
  clearRoute?(): void;
  /** speak an instructor line (TTS); the runner also emits 'activity:instruction' */
  speak?(text: string): void;
}

/** How the flight starts. Altitudes in ft, speeds in kt, headings true deg (aviation units for authoring). */
export type ActivitySetup =
  | {
    spawn: 'runway'; icao: string; runway: string;
    coldAndDark?: boolean; fuelFraction?: number; parkingBrake?: boolean;
    weather?: WeatherPresetId; time?: TimePreset; route?: Waypoint[];
    /** a point at the field (deg): a 'flight:reset' near it restarts the activity instead of aborting it */
    anchor?: { lat: number; lon: number };
  }
  | {
    spawn: 'air'; lat: number; lon: number;
    /** MSL */ altFt: number;
    /** true heading */ headingDeg: number;
    iasKt: number; flapsIndex?: number;
    /** flight-path angle, deg (−3 on a glidepath) */ gammaDeg?: number;
    weather?: WeatherPresetId; time?: TimePreset; route?: Waypoint[];
  };

/** A one-shot callout: said the first time `when` is all true during the step. */
export interface Cue { when: ConditionSpec[]; line: Line; important?: boolean }

export interface StepDef {
  id: string;
  /** short title for the objectives panel */
  title: string;
  /** said once when the step starts */
  instruction: Line;
  /** all required objectives must be done to complete the step */
  objectives: ObjectiveSpec[];
  /** instructor coaching, used in order (each once) when off target, before falling back to live hints */
  hints?: Line[];
  cues?: Cue[];
  /** said when the step completes */
  success?: Line;
  /** seconds continuously off target before a hint (default 4) */
  hintDelayS?: number;
  /** no live hints during this step (pre-flight on the ramp, free navigation) */
  quiet?: boolean;
}

export interface ActivityDef {
  id: string;
  kind: 'lesson' | 'bushTrip';
  title: string;
  /** one or two sentences for the Activities screen */
  description: string;
  /** aircraft config id the activity is written for */
  aircraft?: string;
  setup: ActivitySetup;
  steps: StepDef[];
  /** closing lines, appended to the debrief summary */
  debrief?: { pass: Line; fail: Line };
  /** set for bush-trip legs: progress is recorded per leg */
  trip?: { tripId: string; legIndex: number };
  /** minimum overall score (0..100) to pass, default 0 */
  passScore?: number;
}

export interface ObjectiveResult { label: string; state: ObjectiveState; optional: boolean; score: number; note: string | null }
export interface StepResult { id: string; title: string; score: number; completed: boolean; objectives: ObjectiveResult[] }

/** Debrief produced when an activity ends. */
export interface ActivityResult {
  id: string;
  kind: ActivityDef['kind'];
  title: string;
  success: boolean;
  /** 0..100 */
  score: number;
  grade: 'Excellent' | 'Good' | 'Satisfactory' | 'Needs practice' | 'Incomplete';
  /** one-paragraph summary (also in 'activity:finished') */
  summary: string;
  /** reason when not successful: an objective note, 'crash: …', 'aborted', 'flight changed' */
  reason: string | null;
  durationS: number;
  steps: StepResult[];
  /** total fuel on board at the end, kg (bush trips carry fuel between legs) */
  fuelKg: number;
  /** the last landing scored during the activity (0..10 000), if any */
  landingScore: number | null;
}

export function gradeFor(score: number, success: boolean): ActivityResult['grade'] {
  if (!success) return 'Incomplete';
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 55) return 'Satisfactory';
  return 'Needs practice';
}
