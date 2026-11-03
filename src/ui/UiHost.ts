/**
 * The only contract the UI layer talks through. The integrator (src/app) implements it;
 * the UI never imports other feature modules directly.
 */
import type {
  AircraftConfig, Airport, AssistanceOptions, CameraMode, Geodetic, NavDatabase,
  SimAction, SimSnapshot, Waypoint, WeatherPresetId, WeatherState,
} from '../core/types';
import type { EventBus } from '../core/events';
import type { ActivityDef, ActivityResult, LegRecord, LessonRecord, Line, ObjectiveView, RunnerPhase } from '../activities';

/**
 * Read-only view of the simulator's activity runner (src/activities ActivityRunner) that the UI
 * polls: phase, the current activity, the live objective views of the current step, the hint that
 * applies right now and the debrief of the last finished activity.
 */
export interface ActivityRunnerView {
  readonly phase: RunnerPhase;
  readonly def: ActivityDef | null;
  /** live views of the current step's objectives (mutated in place by the runner) */
  readonly objectives: readonly ObjectiveView[];
  readonly liveHint: Line | null;
  readonly result: ActivityResult | null;
  /** index of the current step (−1 before the first) */
  readonly stepIndex: number;
}

/** Saved activity progress (src/activities ProgressStore): legs unlock in order, lesson best scores. */
export interface ActivityProgressView {
  isLegUnlocked(tripId: string, legIndex: number): boolean;
  isLegCompleted(tripId: string, legIndex: number): boolean;
  /** first incomplete leg (legCount when the trip is done) */
  nextLeg(tripId: string, legCount: number): number;
  completedLegs(tripId: string): number;
  leg(tripId: string, legIndex: number): LegRecord | null;
  resetTrip(tripId: string): void;
  lesson(id: string): LessonRecord | null;
}

export interface RunwayEndChoice {
  runwayIdent: string; endIdent: string; threshold: Geodetic; headingDeg: number; lengthM: number;
  /** localizer frequency of the ILS serving this end, when the nav data has one (display only) */
  ilsMHz?: number;
}
export interface SpawnChoice { airport: Airport; runwayEnd: RunwayEndChoice | null /* null = parking, cold & dark */; coldAndDark: boolean }
export interface GraphicsSettings { quality: 'low' | 'medium' | 'high' | 'ultra'; renderScale: number; shadows: boolean; clouds: boolean; terrainDetail: number; imagery: 'satellite' | 'procedural'; fov: number }
export interface AudioSettings { master: number; engine: number; environment: number; cockpit: number; ui: number; atc: number }
export interface UnitsSettings { altitude: 'ft' | 'm'; speed: 'kt' | 'kmh' | 'mph'; pressure: 'inHg' | 'hPa'; distance: 'nm' | 'km'; temperature: 'C' | 'F' }
export interface BindingInfo { action: SimAction; label: string /* e.g. 'Ctrl+E' */; device: 'keyboard' | 'gamepad' | 'mouse' | 'none'; group: string }

export interface UiHost {
  readonly events: EventBus;
  readonly nav: NavDatabase;
  snapshot(): SimSnapshot;                    // latest frame snapshot (read-only)
  aircraftList(): AircraftConfig[];           // selectable aircraft
  currentAircraft(): AircraftConfig;
  dispatch(action: SimAction): void;          // same path as a key press
  spawn(choice: SpawnChoice, aircraftId: string, options: { fuelFraction: number; payloadKg: number }): Promise<void>;
  /**
   * `immediate: true` (sent when a new flight starts) asks for no blend, so the flight begins in
   * the chosen weather; otherwise the host may transition gradually while flying.
   */
  setWeatherPreset(id: WeatherPresetId, opts?: { immediate?: boolean }): void;
  setCustomWeather(w: WeatherState, opts?: { immediate?: boolean }): void;
  requestLiveWeather(): Promise<boolean>;
  setTime(utcMs: number): void;               // sets the world clock
  setTimeScale(scale: number): void;
  setPaused(paused: boolean): void;
  setCamera(mode: CameraMode): void;
  setAssists(a: AssistanceOptions): void;
  setGraphics(g: GraphicsSettings): void;
  setAudio(a: AudioSettings): void;
  setUnits(u: UnitsSettings): void;
  bindings(): BindingInfo[];                  // for the help sheet and the controls page
  rebind(action: SimAction): Promise<BindingInfo | null>; // waits for the next key/button
  /**
   * Replaces the bindings with a built-in layout. 'default' is the input module's out-of-the-box
   * keyboard set (MSFS numpad layout + laptop layer merged); 'msfs' and 'laptop' are each layer alone.
   */
  resetBindings(profile: 'default' | 'msfs' | 'laptop' | 'gamepad-xbox' | 'joystick-generic'): void;
  dataCredits(): string[];                    // attribution lines
  captureInput(captured: boolean): void;      // true while a menu owns the keyboard

  // ── Optional extensions (the UI feature-detects each; omit freely) ──────────────────
  /**
   * World Map "Set as arrival" and VFR-map "Direct to": appends a waypoint to the active
   * flight plan. When absent, the UI hides those buttons.
   */
  addWaypoint?(wp: Waypoint): void;
  /** Clears the flight plan (Nav Log "Clear"). Hidden when absent. */
  clearPlan?(): void;
  /**
   * Activities → Landing challenges: spawn established on final for the challenge `id`
   * (an id from `LANDING_CHALLENGES`). Resolves when the flight is live. When absent, the
   * Activities screen lists the challenges but disables "Start".
   */
  startChallenge?(id: string): Promise<void>;
  /** COM1 active/standby frequencies, MHz: the ATC panel header shows the tuned station. */
  comRadio?(): { activeMHz: number; standbyMHz: number } | null;
  /**
   * Magnetic variation (deg, east positive) at a place, e.g. from the World Magnetic Model. The
   * World Map then shows runway headings magnetic, as charts and the compass do; without it they
   * are labelled true ('298°T').
   */
  magneticVariationDeg?(lat: number, lon: number): number;
  /** Cancels a pending `rebind` (its promise resolves null): Settings calls it when the screen closes. */
  cancelRebind?(): void;
  /**
   * Settings › General › "Flight info strip" (pushed at startup and on change). Lets a host that
   * draws its own speed/altitude/heading strip (an instruments HUD replacing the UI's) honour it.
   */
  setInfoStrip?(visible: boolean): void;

  // ── Activities: Flight Training lessons and bush trips (src/activities) ──
  /** Activities › Flight training "Start": a lesson id from `LESSONS`. Resolves when the flight is live. */
  startLesson?(id: string): Promise<void>;
  /** Activities › Bush trips "Start" / "Resume" / debrief "Next leg": leg `legIndex` of a `BUSH_TRIPS` trip. */
  startBushLeg?(tripId: string, legIndex: number): Promise<void>;
  /** Pause menu "Abort activity": ends the running activity (unsuccessfully); the flight goes on. */
  abortActivity?(): void;
  /** Debrief "Retry": starts the current (or last) activity again from its set-up. */
  restartActivity?(): Promise<void>;
  /** Pause menu "Restart step": resets the current step's objectives (the aircraft is not moved). */
  restartActivityStep?(): void;
  /** The runner, polled by the objectives panel (live progress and hint) and the debrief. */
  readonly activityRunner?: ActivityRunnerView;
  /** Saved progress for the Activities screen (completed badges, best scores, unlocked legs). */
  readonly activityProgress?: ActivityProgressView;
}
