/**
 * The only contract the UI layer talks through. The integrator (src/app) implements it;
 * the UI never imports other feature modules directly.
 */
import type {
  AircraftConfig, Airport, AssistanceOptions, CameraMode, Geodetic, NavDatabase,
  SimAction, SimSnapshot, Waypoint, WeatherPresetId, WeatherState,
} from '../core/types';
import type { EventBus } from '../core/events';

export interface RunwayEndChoice { runwayIdent: string; endIdent: string; threshold: Geodetic; headingDeg: number; lengthM: number }
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
  setWeatherPreset(id: WeatherPresetId): void;
  setCustomWeather(w: WeatherState): void;
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
  resetBindings(profile: 'msfs' | 'laptop' | 'gamepad-xbox' | 'joystick-generic'): void;
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
}
