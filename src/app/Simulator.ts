/**
 * The simulator: owns every subsystem, the fixed-step physics loop and the render loop, and
 * assembles the SimSnapshot that instruments, audio and UI read each frame.
 */
import * as THREE from 'three';
import { EventBus } from '../core/events';
import { clamp, mulberry32, qConj, qMul, qRotate, wrap360, wrapTwoPi } from '../core/math';
import { FAILURE_IDS, defaultControlInputs, type FailureId, type AircraftConfig, type AircraftState, type Airport, type Runway, type AssistanceOptions, type ControlInputs, type InputSnapshot, type SimAction, type SimSnapshot, type SpawnState, type TimeState, type WeatherPresetId, type WeatherState, type Waypoint, type LateralMode, type VerticalMode } from '../core/types';
import { DEG, FPM, FT, INHG, KT, RAD } from '../core/units';
import { Fdm } from '../fdm/fdm';
import { C172S } from '../fdm/aircraft/c172';
import { atmosphere, casFromTas } from '../fdm/atmosphere';
import { NavDb, FlightPlanner, fetchLoader, runwayInUse, type FlightPlanEx } from '../nav';
import { magneticDeclinationDeg } from '../geo/magvar';
import { sunEvents, sunPosition } from '../geo/solar';
import { LocalFrame, greatCircleDistance, nedToThree } from '../geo/wgs84';
import { World } from '../world/World';
import type { PavementArea, PavementSource } from '../world/pavement';
import { LandingGuide } from '../world/LandingGuide';
import { ActivityRunner, Logbook, LogbookRecorder, ProgressStore } from '../activities';
import { makeActivityHost } from './activityHost';
import { TerrainSystem } from '../terrain/TerrainSystem';
import { SkySystem, WeatherSystem } from '../sky';
import { GroundSnowState, groundSnowFor, snowAt, type GroundSnowMode } from '../sky/groundSnow';
import { seasonFor } from '../sky/season';
import { AircraftModel, bodyQuatToThree } from '../aircraft3d';
import { CameraController } from '../camera';
import { InputManager } from '../input/InputManager';
import { FlightAssists, GfcAutopilot, assistsConfigFor, type NavInputs } from '../autopilot';
import { SteamPanel, type PanelLayout } from '../instruments/SteamPanel';
import { hasAutopilot, panelSpecFor, steamLayoutFor } from '../instruments/panels';
import { C172S_G1000, aircraftById, aircraftForActivity, radioCallsign, sameAirframe } from './aircraftCatalog';
import { TouchdownDetector } from '../activities/TouchdownDetector';
import { ReplayRecorder } from '../activities/ReplayRecorder';
import { LANDING_CHALLENGES } from '../activities/landingChallenges';
import { runwayEnds, type RunwayEndRef } from '../activities/runwayFrame';
import { FixedStepLoop, PHYSICS_DT } from './loop';
import { copyPose, interpolateState } from './interpolate';
import { RadioStack } from './radios';
import { ReplayController } from './ReplayController';
import { ReplayBar } from './replayBar';
import { CockpitInteraction } from './cockpitInteraction';
import { SlewController, SLEW_THROTTLE_CENTRE } from './slew';
import { StressMonitor, crashIsRecoverable } from './damage';
import type { RebaseTransform } from '../world/rebase';
import { QUALITY, createRenderer, type RendererBundle } from './renderer';
import { PostFx } from './postFx';
import { DynamicResolution } from './dynamicResolution';
import { CarbIce } from './carbIce';
import { TrafficManager, rankRunways } from '../traffic/TrafficManager';
import { TaxiGraph, type TaxiRoute } from '../world/taxiGraph';
import { TaxiRibbon } from '../world/TaxiRibbon';
import { TrafficAdvisor } from '../traffic/advisor';
import { C172S as C172S_TRAFFIC } from '../fdm/aircraft/c172';
import { PA18_150 as CUB_TRAFFIC } from '../fdm/aircraft/cub';

export interface SimulatorOptions {
  container: HTMLElement;
  /** base URL for /data (Vite BASE_URL) */
  baseUrl: string;
  quality?: 'low' | 'medium' | 'high' | 'ultra';
  /** stream real terrain (default true) */
  terrain?: boolean;
  imagery?: 'satellite' | 'procedural';
}

/**
 * OSM scenery plugin contract (src/scenery/index.ts exports `createScenery(options)` returning this):
 * buildings, airport surfaces, vegetation and night lighting streamed around the camera.
 */
export interface SceneryLike {
  /** per display frame, after the terrain update; camera position in the render frame */
  update(dt: number, cameraPosThree: THREE.Vector3, camera: THREE.PerspectiveCamera, sunElevationRad: number): void;
  /** a new flight origin or a floating-origin rebase: re-express everything in `frame` */
  setFrame(frame: LocalFrame): void;
  setQuality?(q: 'low' | 'medium' | 'high' | 'ultra'): void;
  setVisible?(on: boolean): void;
  /** lying snow at the scenery's altitude, 0…1 */
  setSnow?(amount: number): void;
  /** seasonal vegetation 0…1 */
  setSeason?(autumn: number, dormant: number): void;
  /** stands / gates / apron positions near a point, best first (for parking spawns) */
  parkingSpots?(lat: number, lon: number, radiusM: number): Promise<{ lat: number; lon: number; headingDeg: number; name: string; kind?: 'gate' | 'stand' }[]>;
  attribution?(): string[];
  /** airport pavement (aprons, taxiways) of the tiles it has, for terrain flattening (src/world/pavement.ts) */
  pavementRevision?(): number;
  pavementAreas?(): readonly PavementArea[];
  stats?(): Record<string, number>;
  dispose?(): void;
}

/**
 * The clickable G1000 panel (`G1000Panel` in instruments/g1000/panel.ts): maps a ray-cast UV on
 * the G1000 panel mesh to a bezel control. Used by CockpitInteraction.
 */
export interface G1000PanelLike {
  click(u: number, v: number): boolean;
  wheel(u: number, v: number, deltaY: number, opts?: { deltaMode?: number; outer?: boolean }): boolean;
  hover(u: number, v: number): { title: string; hint: string } | null;
  readonly g1000: { readonly wantsKeyboard: boolean; keyboard(key: string): boolean };
}

export type SeasonMode = 'auto' | 'summer' | 'autumn' | 'winter';
const SEASON_PRESETS: Record<Exclude<SeasonMode, 'auto'>, { autumn: number; dormant: number }> = {
  summer: { autumn: 0, dormant: 0 }, autumn: { autumn: 1, dormant: 0 }, winter: { autumn: 0, dormant: 1 },
};

/** A saved flight ("Save flight" in the pause menu; resumed from the main menu). JSON-safe. */
export interface SavedFlight {
  v: 1;
  savedAtMs: number;
  aircraftId: string;
  airportIcao: string | null;
  geo: { lat: number; lon: number; alt: number };
  headingRad: number;
  onGround: boolean;
  /** the render/physics frame the flight-model state is expressed in */
  frame: { lat0: number; lon0: number; alt0: number };
  /** Fdm.serialize() */
  fdm: string;
  controls: ControlInputs;
  weather: WeatherState;
  utcMs: number;
  plan: Waypoint[];
  activeLeg: number;
  failures: FailureId[];
  /** NAV1/NAV2 tuning and COM1 (absent in older saves) */
  radios?: { tuning: { activeKHz: number; standbyKHz: number; obsDeg: number }[]; com1: { activeMHz: number; standbyMHz: number } };
  /** autopilot modes and targets (absent in older saves) */
  autopilot?: {
    engaged: boolean; flightDirector: boolean; yawDamper: boolean; lateral: string; vertical: string;
    armedLateral: string | null; armedVertical: string | null;
    headingBugDeg: number; altitudeTargetM: number; verticalSpeedTargetMs: number; iasTargetMs: number;
  };
}

/** Optional subsystems attached after construction (UI, glass cockpit, HUD, audio, ATC, scenery). */
export interface SimPlugins {
  scenery?: SceneryLike;
  ui?: { update(s: SimSnapshot, dt: number): void; handleAction?(a: SimAction): boolean; coversView?(): boolean };
  g1000?: { update(s: SimSnapshot, dt: number): boolean; reset?(s: SimSnapshot): void; readonly pfdCanvas: HTMLCanvasElement | OffscreenCanvas; readonly interactive?: G1000PanelLike };
  hud?: { update(s: SimSnapshot, dt: number): void; reset?(): void; resize(w: number, h: number, dpr: number): void; readonly canvas: HTMLCanvasElement | OffscreenCanvas };
  audio?: { update(dt: number, ac: AircraftState, cam: SimSnapshot['camera'], w: SimSnapshot['weather']): void; onTouchdown?(vsMs: number, lateralDriftMs?: number): void; setMarker?(m: string | null): void; setAircraft?(config: AircraftConfig): void };
  atc?: { update(dt: number, ac: AircraftState, w: SimSnapshot['weather']): void; select(i: number): void; reset(a: Airport | null): void };
}

export const DEFAULT_ASSISTS: AssistanceOptions = {
  autoRudder: false, assistedTakeoff: false, assistedLanding: false, autoMixture: true, unlimitedFuel: false,
  crashDamage: true, stressDamage: false, gyroDrift: false, landingPathHints: true, taxiRibbon: false, routeRibbon: true,
  antiStall: false,
};

/** Longest wait for the terrain under a spawn before placing the aircraft anyway, ms. */
const SPAWN_TERRAIN_WAIT_MS = 20_000;
/** mean flying time between random failures, s */
const RANDOM_FAILURE_MTBF_S = 45 * 60;
export const FAILURE_LABELS: Readonly<Record<FailureId, string>> = {
  engine: 'engine', vacuum: 'vacuum pump', pitot: 'pitot tube blocked', static: 'static port blocked',
  alternator: 'alternator', electrical: 'electrical system', avionics: 'avionics bus', carbIce: 'carburettor icing',
};
const SPAWN_ROLL_OFFSET_M = 40;
/** an air start is raised to at least this height above the terrain under it, m */
const AIR_SPAWN_MIN_AGL_M = 150;

/** Aircraft family the landing challenges are written for (approach speeds, flaps 2 of 4). */
const LANDING_CHALLENGE_AIRCRAFT = 'c172';

/** Autopilot / flight-director / heading-bug actions: ignored when the aircraft has no autopilot. */
const AP_ACTIONS: ReadonlySet<SimAction> = new Set<SimAction>([
  'apToggle', 'apHdg', 'apNav', 'apApr', 'apAlt', 'apVs', 'apFlc', 'apLvl', 'fdToggle', 'yawDamper',
  'apHdgInc', 'apHdgDec', 'apAltInc', 'apAltDec', 'apVsInc', 'apVsDec', 'apIasInc', 'apIasDec', 'apHdgSync', 'apAltSync',
  'headingBugInc', 'headingBugDec',
]);
const NO_ROTATION: [number, number, number, number] = [1, 0, 0, 0];

export class Simulator {
  readonly events = new EventBus();
  readonly time: TimeState = { utcMs: Date.now(), timeScale: 1, simTimeS: 0 };
  assists: AssistanceOptions = { ...DEFAULT_ASSISTS };
  paused = true;
  inFlight = false;
  slew = false;
  hudVisible = true;
  frameCount = 0;
  fps = 0;
  /** smoothed milliseconds per frame phase (for profiling and the stats overlay) */
  readonly timings = { input: 0, physics: 0, world: 0, sky: 0, instruments: 0, render: 0 };

  /** the aircraft being flown: its catalog entry (aircraftCatalog.ts; the 172S G1000 has its own). Change it with `selectAircraft` / `setAircraft`. */
  config: AircraftConfig = C172S;
  readonly nav: NavDb;
  /** the flight model of the current aircraft (replaced when the airframe changes) */
  fdm: Fdm;
  readonly weather: WeatherSystem;
  readonly world: World;
  readonly terrain: TerrainSystem | null;
  readonly scene = new THREE.Scene();
  readonly gfx: RendererBundle;
  /** HDR + bloom post-processing (Settings > Graphics > Bloom) */
  readonly postFx: PostFx;
  /** lowers the render resolution while the frame rate is below target (Settings › Graphics › Dynamic resolution) */
  readonly dynRes = new DynamicResolution();
  readonly sky: SkySystem;
  /** the 3D airframe and cockpit of the current aircraft (rebuilt, the old one disposed, when the airframe changes) */
  model: AircraftModel;
  readonly cameras: CameraController;
  readonly input: InputManager;
  readonly autopilot: GfcAutopilot;
  /** auto-rudder, assisted take-off heading hold and anti-stall (MSFS assistance options), tuned for the aircraft */
  flightAssists: FlightAssists;
  private readonly navIn: NavInputs;
  readonly radios: RadioStack;
  readonly planner = new FlightPlanner();
  readonly touchdown: TouchdownDetector;
  readonly replay = new ReplayRecorder(300, 30);
  readonly replayer = new ReplayController(this.replay);
  private replayBar: ReplayBar | null = null;
  private cockpitUi: CockpitInteraction | null = null;
  /** the steam panel of the current aircraft (C172S six-pack or the Super Cub panel) */
  steam: SteamPanel;
  readonly plugins: SimPlugins = {};
  /** landing-path assist gates */
  readonly landingGuide = new LandingGuide();
  /** lessons and bush-trip legs (src/activities); progress persists per browser */
  readonly activityProgress = new ProgressStore();
  readonly activities: ActivityRunner;
  /** instructor voice (the audio plugin sets it: text is already spelled out for speech) */
  speakInstructor?: (text: string) => void;
  /** ATC voice (audio plugin): traffic advisories */
  speakAtc?: (text: string) => void;
  /** slew mode pose and motion (active while `slew` is true) */
  readonly slewCtl = new SlewController();
  /** effective controls after assists and autopilot, fed to the flight model */
  readonly effective: ControlInputs = defaultControlInputs();
  /** automation overrides applied after the input layer (tests, smoke test, scripted demos) */
  readonly overrides: Partial<ControlInputs> = {};
  /** Settings > Controls: game-style pitch (arrow up / stick forward raises the nose) */
  invertPitch = false;
  lastSpawn: { airport: Airport | null; spawn: SpawnState; end: RunwayEndRef | null } | null = null;
  currentAirport: Airport | null = null;
  panelVariant: 'steam' | 'g1000' = 'steam';
  weatherPreset: WeatherPresetId = 'few';

  private readonly loop = new FixedStepLoop(PHYSICS_DT);
  private prev: AircraftState;
  private interp: AircraftState;
  private plan: FlightPlanEx | null = null;
  private steamTex: THREE.CanvasTexture;
  private readonly aircraftListeners: ((config: AircraftConfig) => void)[] = [];
  private g1000Tex: THREE.CanvasTexture | null = null;
  private lastMs = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private autoStartT = -1;
  private readonly stress = new StressMonitor();
  private crashReported = false;
  private screenshotPending = false;
  private droneHold: { pitch: number; roll: number; yaw: number; throttle: number } | null = null;
  private nearbyAirports: Airport[] = [];
  private nearbyTimer = Infinity;
  /** AI pattern traffic at the current airport (src/traffic) */
  readonly traffic = new TrafficManager({ c172: C172S_TRAFFIC, cub: CUB_TRAFFIC, maxAircraft: 2 });
  private trafficTimer = Infinity;
  private readonly trafficAdvisor = new TrafficAdvisor();
  /** taxi-ribbon assist: graph of the current airport's OSM taxiways and the ribbon on the ground */
  readonly taxiRibbon = new TaxiRibbon();
  private taxiGraph: TaxiGraph | null = null;
  private taxiGraphKey = '';
  private taxiTimer = Infinity;
  private taxiAnnounced = '';
  /** the runway ATC cleared the player to taxi to (the ribbon follows it) */
  private clearedRunway: { icao: string; ident: string } | null = null;
  private trafficStands: readonly { lat: number; lon: number; headingDeg: number }[] = [];
  private trafficStandsFor = '';
  /** the last taxi route (automation, UI): runway, taxiway names and length */
  taxiRoute: { runway: string; via: string[]; lengthM: number } | null = null;
  private advisoryTimer = 0;
  /** simulated seconds advanced by the last frame (0 paused, slewing or replaying) */
  private lastSimDt = 0;
  /** the runway end of the last runway spawn (AI traffic keeps it in calm wind) */
  private spawnRunwayIdent: string | null = null;
  private magVar = 0;
  private magTimer = Infinity;
  private raf = 0;
  private readonly posThree = new THREE.Vector3();
  private readonly qThree = new THREE.Quaternion();
  private readonly v3: [number, number, number] = [0, 0, 0];
  private readonly tmpV = new THREE.Vector3();
  readonly snapshot: SimSnapshot;

  constructor(readonly opts: SimulatorOptions) {
    this.gfx = createRenderer(opts.container, opts.quality ?? 'high');
    this.postFx = new PostFx(this.gfx.renderer, QUALITY[opts.quality ?? 'high'].antialias);
    this.nav = new NavDb(fetchLoader(opts.baseUrl));
    this.fdm = new Fdm(this.config, { seed: 1 });
    this.fdm.setFuelFraction(1);
    this.weather = new WeatherSystem({});
    this.weather.setPreset(this.weatherPreset, 0);
    const home = new LocalFrame(37.613538, -122.35716, 0);
    this.terrain = opts.terrain === false ? null : new TerrainSystem(home, { depthMode: this.gfx.depthMode, maxAnisotropy: this.gfx.maxAnisotropy, imagery: opts.imagery ?? 'satellite' });
    this.world = new World(this.terrain, this.nav, this.weather, home.lat0, home.lon0);
    // the scenery plugin (attached later) publishes the aprons / taxiways the terrain flattens
    this.world.setPavementSource(() => {
      const sc = this.plugins.scenery;
      return sc && sc.pavementAreas && sc.pavementRevision ? (sc as PavementSource) : null;
    });
    this.scene.add(this.world.group);
    this.sky = new SkySystem(this.scene, this.gfx.renderer, { shadows: this.gfx.renderer.shadowMap.enabled });
    this.model = new AircraftModel(this.config);
    this.scene.add(this.model.root);
    this.scene.add(this.landingGuide.group);
    this.scene.add(this.traffic.group);
    this.scene.add(this.taxiRibbon.group);
    const aspect = (opts.container.clientWidth || 1) / (opts.container.clientHeight || 1);
    this.cameras = new CameraController(aspect);
    this.input = new InputManager(this.gfx.renderer.domElement, { flapDetents: this.config.controls.flaps.detentsDeg.length });
    this.autopilot = new GfcAutopilot({ events: this.events });
    this.radios = new RadioStack(this.nav);
    this.flightAssists = new FlightAssists(assistsConfigFor(this.config));
    this.navIn = { nav1: this.radios.nav1, nav2: this.radios.nav2, plan: null };
    this.touchdown = new TouchdownDetector(this.events, { airports: () => this.nearbyAirports });
    this.activities = new ActivityRunner({ host: makeActivityHost(this, (t) => this.speakInstructor?.(t)), events: this.events, progress: this.activityProgress });
    this.steam = new SteamPanel({ layout: steamLayoutFor(this.config), spec: panelSpecFor(this.config) });
    this.steamTex = this.makeSteamTexture();
    this.prev = structuredClone(this.fdm.state);
    this.interp = structuredClone(this.fdm.state);
    this.snapshot = this.buildSnapshot();
    if (typeof document !== 'undefined') {
      this.replayBar = new ReplayBar(opts.container, this.replayer, (on) => this.setPaused(on || this.paused));
      this.cockpitUi = new CockpitInteraction(this, opts.container);
    }
    this.events.on('aircraft:crash', (e) => this.onCrash(e.reason));
    window.addEventListener('resize', this.onResize);
  }

  /**
   * Start the instruments from the current state: gyro drift, timers, lags and the AFCS flash
   * history must not carry over from the previous flight (needles would sweep in).
   */
  private resetInstruments(): void {
    interpolateState(this.prev, this.fdm.state, 1, this.interp);
    const snap = this.refreshSnapshot();
    this.steam.reset(snap);
    this.plugins.g1000?.reset?.(snap);
    this.plugins.hud?.reset?.();
  }

  /** Attach a glass cockpit: its PFD canvas replaces the steam panel texture. */
  attachG1000(g: NonNullable<SimPlugins['g1000']>): void {
    this.plugins.g1000 = g;
    this.g1000Tex = new THREE.CanvasTexture(g.pfdCanvas as HTMLCanvasElement);
    this.g1000Tex.colorSpace = THREE.SRGBColorSpace;
  }

  /**
   * Swap the cockpit panel between steam gauges and the G1000 (falls back to steam if no G1000 is
   * attached, and on airframes without a glass cockpit: the Super Cub). The 172S catalog entry follows
   * the panel shown (`config` becomes the 172S G1000 with the glass panel, the 172S without).
   */
  setPanel(variant: 'steam' | 'g1000'): void {
    const glass = variant === 'g1000' && !!this.g1000Tex && this.model.airframe === 'c172';
    const next = glass ? 'g1000' : 'steam';
    // the newly shown panel has not been stepped while hidden: start it from the current state
    if (next !== this.panelVariant) {
      const snap = this.refreshSnapshot();
      if (next === 'steam') this.steam.reset(snap); else this.plugins.g1000?.reset?.(snap);
    }
    this.panelVariant = next;
    if (glass && this.g1000Tex) {
      this.model.setPanelVariant('g1000');
      const mesh = this.model.panelMeshG1000;
      mesh.material.map = this.g1000Tex;
      mesh.material.needsUpdate = true;
    } else {
      this.model.setPanelVariant('steam');
      // the G1000's CDI source steers the autopilot's NAV/APR; the steam panel has no CDI key
      this.autopilot.setNavSource('auto');
    }
    const entry = glass ? C172S_G1000 : C172S;
    if (entry !== this.config && sameAirframe(entry, this.config)) this.config = entry;
  }

  // ─────────────────────────────── aircraft ───────────────────────────────

  /** The steam panel's layout for the current aircraft (cockpit hit-testing, automation). */
  get panelLayout(): PanelLayout { return this.steam.layout; }

  /** The current aircraft has an autopilot (the Super Cub has none: AP keys do nothing). */
  get hasAutopilot(): boolean { return hasAutopilot(this.config); }

  /** Called after the aircraft changed (plugins rebuild what depends on it, e.g. the ATC callsign). */
  onAircraftChange(cb: (config: AircraftConfig) => void): () => void {
    this.aircraftListeners.push(cb);
    return () => { const i = this.aircraftListeners.indexOf(cb); if (i >= 0) this.aircraftListeners.splice(i, 1); };
  }

  /**
   * Switch aircraft by catalog id ('c172s', 'c172s-g1000', 'pa18-150'; a family prefix such as 'pa18'
   * picks its first entry). A different airframe gets a new flight model, 3D model (the old one is
   * disposed), steam panel and texture, flap detents, assists tuning and audio profile; the 172S ↔
   * 172S G1000 switch only swaps the panel. The flight is not restarted: spawn afterwards (the UI's
   * spawn and the activities do), or use `setAircraft`. Returns false for an unknown id.
   */
  selectAircraft(id: string): boolean {
    const next = aircraftById(id);
    if (!next) return false;
    const before = this.config;
    if (!sameAirframe(before, next)) this.rebuildAirframe(next);
    this.config = next;
    // the catalog entry decides the panel (the Cub has only its steam panel)
    this.setPanel(next.panel === 'c172-g1000' ? 'g1000' : 'steam');
    if (!this.hasAutopilot) this.autopilot.reset();
    if (this.config !== before) for (const cb of [...this.aircraftListeners]) cb(this.config);
    return true;
  }

  /**
   * Fly an aircraft of `family` (an activity's `aircraft`, e.g. 'c172' or 'pa18-150'): keeps the
   * current one when it belongs to the family (a 172 lesson keeps the G1000 when that is selected),
   * else selects the family's first catalog entry. No family: no change.
   */
  useAircraftFor(family: string | undefined): void {
    const next = aircraftForActivity(family, this.config);
    if (next !== this.config) this.selectAircraft(next.id);
  }

  /** `selectAircraft`, then restart the flight at the last spawn when one is in progress (automation, `__sim.setAircraft`). */
  async setAircraft(id: string): Promise<boolean> {
    const before = this.config;
    if (!this.selectAircraft(id)) return false;
    if (this.config !== before && this.lastSpawn) await this.respawn();
    return true;
  }

  private makeSteamTexture(): THREE.CanvasTexture {
    const tex = new THREE.CanvasTexture(this.steam.canvas as HTMLCanvasElement);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, this.gfx.maxAnisotropy);
    this.model.panelMesh.material.map = tex;
    this.model.panelMesh.material.needsUpdate = true;
    return tex;
  }

  /** New airframe: rebuild everything that is built from the aircraft configuration. */
  private rebuildAirframe(next: AircraftConfig): void {
    // replayed frames, the slew pose and an engine start belong to the old airframe
    if (this.replayer.active) this.replayer.exit();
    this.replay.clear();
    if (this.slew) { this.slew = false; this.slewCtl.exit(); }
    this.autoStartT = -1;
    this.fdm = new Fdm(next, { seed: 1 });
    this.fdm.setFuelFraction(1);
    this.prev = structuredClone(this.fdm.state);
    this.interp = structuredClone(this.fdm.state);
    this.snapshot.aircraft = this.interp;
    this.scene.remove(this.model.root);
    this.model.dispose();
    this.model = new AircraftModel(next);
    this.scene.add(this.model.root);
    this.steam.dispose();
    this.steamTex.dispose();
    this.steam = new SteamPanel({ layout: steamLayoutFor(next), spec: panelSpecFor(next) });
    this.steamTex = this.makeSteamTexture();
    // the new model's G1000 plane (C172) gets the glass texture again in setPanel
    this.panelVariant = 'steam';
    this.input.setFlapDetents(next.controls.flaps.detentsDeg.length);
    this.flightAssists = new FlightAssists(assistsConfigFor(next));
    this.autopilot.reset();
    this.stress.reset();
    this.crashReported = false;
    this.touchdown.reset(true);
    this.plugins.audio?.setAircraft?.(next);
  }

  start(): void {
    this.lastMs = performance.now();
    if (typeof window !== 'undefined') window.addEventListener('pagehide', () => this.closeLog());
    const tick = (now: number) => { this.raf = requestAnimationFrame(tick); this.frame(now); };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void { cancelAnimationFrame(this.raf); }

  // ─────────────────────────────── frame loop ───────────────────────────────

  /** One display frame: input → physics (fixed steps) → world/sky/camera → instruments → render. */
  frame(nowMs: number): void {
    const rawDt = (nowMs - this.lastMs) / 1000;
    const dt = clamp(rawDt, 0, 0.25);
    this.lastMs = nowMs;
    this.frameCount++;
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) { this.fps = this.fpsFrames / this.fpsAcc; this.fpsAcc = 0; this.fpsFrames = 0; }
    // a full-screen menu renders the world only every 16th frame: no frame-rate signal then
    if (!this.plugins.ui?.coversView?.() && this.dynRes.update(rawDt)) this.gfx.setDynamicScale(this.dynRes.scale);

    const t0 = performance.now();
    const inp = this.input.poll(dt);
    for (let i = 0; i < inp.actions.length; i++) this.handleAction(inp.actions[i]);
    const running = this.inFlight && !this.paused && !this.replayer.active && !this.slew;
    const scale = running ? this.time.timeScale : 0;
    // the autopilot and assists run on simulated time: frozen while paused, faster under time compression
    this.composeControls(dt, running ? dt * Math.min(scale, 8) : 0);
    const t1 = performance.now();
    let alpha = 1;
    this.lastSimDt = 0;
    if (running) {
      const r = this.loop.advance(dt, Math.min(scale, 8), () => copyPose(this.fdm.state, this.prev), (h) => this.physicsStep(h));
      alpha = r.alpha;
      this.time.utcMs += r.simDt * 1000;
      this.time.simTimeS += r.simDt;
      this.lastSimDt = r.simDt;
      if (scale > 8) this.time.utcMs += dt * (scale - 8) * 1000; // time compression beyond physics speed moves only the clock
    }
    interpolateState(this.prev, this.fdm.state, running ? alpha : 1, this.interp);
    if (this.slew && !this.replayer.active) this.slewFrame(dt);
    if (this.replayer.active) this.replayer.update(dt, this.interp, this.world.frame);
    this.replayBar?.update(this.inFlight && !(this.plugins.ui?.coversView?.() ?? false));
    this.cockpitUi?.update();
    const t2 = performance.now();
    this.mark('input', t1 - t0);
    this.mark('physics', t2 - t1);
    this.updateVisuals(dt, inp);
  }

  private mark(k: keyof Simulator['timings'], ms: number): void { this.timings[k] += (ms - this.timings[k]) * 0.1; }

  /**
   * Pilot controls → autopilot → assists → effective controls (allocation-free).
   * @param dt display seconds (engine auto-start timer); simDt simulated seconds (autopilot, assists)
   */
  private composeControls(dt: number, simDt: number): void {
    const u = this.input.controls;
    // While the drone camera is flying, the stick moves the drone: freeze the aircraft's flight
    // controls at the values they had when the drone was entered.
    const drone = this.cameras.state.mode === 'drone';
    if (drone && !this.droneHold) this.droneHold = { pitch: this.effective.pitch, roll: this.effective.roll, yaw: this.effective.yaw, throttle: this.effective.throttle };
    else if (!drone) this.droneHold = null;
    Object.assign(this.effective, u);
    if (this.invertPitch) this.effective.pitch = -this.effective.pitch;
    this.effective.lights = u.lights;
    if (this.droneHold) Object.assign(this.effective, this.droneHold);
    for (const k in this.overrides) (this.effective as unknown as Record<string, unknown>)[k] = (this.overrides as Record<string, unknown>)[k];
    const s = this.fdm.state;
    if (this.assists.autoMixture && this.effective.mixture > 0.05 && s.engine.running) this.effective.mixture = Math.min(this.effective.mixture, this.fdm.peakPowerMixture());
    // engine auto-start sequence (Ctrl+E)
    if (this.autoStartT >= 0) {
      this.autoStartT += dt;
      this.effective.mixture = 1; this.effective.magnetos = 3; this.effective.fuelSelector = 'both';
      this.effective.masterBattery = true; this.effective.masterAlternator = true;
      this.input.controls.masterBattery = true; this.input.controls.masterAlternator = true;
      this.effective.throttle = Math.max(this.effective.throttle, 0.12);
      this.effective.starter = this.autoStartT > 0.6 && !s.engine.running;
      if (s.engine.running && this.autoStartT > 1.5) {
        this.autoStartT = -1;
        this.input.controls.mixture = 1; this.input.controls.magnetos = 3; this.input.controls.fuelSelector = 'both';
        this.input.controls.avionicsMaster = true;
        this.events.emit('engine:started', {});
      } else if (this.autoStartT > 12) this.autoStartT = -1;
    }
    this.navIn.plan = this.plan;
    // no autopilot fitted (Super Cub): it stays reset (off, nothing armed, no altitude alerter)
    if (this.hasAutopilot) {
      this.autopilot.update(simDt, s, this.navIn);
      const ap = this.autopilot.apply(this.effective);
      if (ap !== this.effective) Object.assign(this.effective, ap);
      // persist the auto-trim: `effective` is rebuilt from input.controls every frame, so without this
      // the trim would snap back to the pilot's old setting when the autopilot disconnects
      if (this.autopilot.state.engaged) this.input.controls.pitchTrim = this.autopilot.state.trimCommand;
    }
    // assists act on what the flight model flies, after the autopilot (auto-rudder sees its aileron)
    this.flightAssists.apply(this.effective, s, simDt, this.assists);
    // system failures act on what the aircraft can actually do
    const f = this.failures;
    if (f.engine) this.effective.mixture = 0; // fuel starvation: the engine stops and will not restart
    if (f.alternator) this.effective.masterAlternator = false;
    if (f.electrical) { this.effective.masterBattery = false; this.effective.masterAlternator = false; }
    if (f.avionics) this.effective.avionicsMaster = false;
    if (this.carburetted) this.applyCarbIce(simDt, !!f.carbIce);
    if (this.randomFailures && simDt > 0) this.rollRandomFailure(simDt);
  }

  /** Pilot logbook (Main menu › Logbook): one entry per flight, newest first. */
  readonly logbook = new Logbook(safeLocalStorage());
  private readonly logRecorder = new LogbookRecorder();
  private logNearest: string | null = null;
  private logLastT = 0;
  /** End the running flight's log entry (page closing): it is written if worth logging. */
  closeLog(): void { const e = this.logRecorder.end(); if (e) this.logbook.add(e); }
  /** ICAO of an airport within 3 km of a point (from the nearby list), else null. */
  private airportNear(lat: number, lon: number): string | null {
    let best: string | null = null, bd = 3000;
    for (const a of this.nearbyAirports) { const d = greatCircleDistance({ lat, lon, alt: 0 }, a.position); if (d < bd) { bd = d; best = a.icao; } }
    return best;
  }

  /** Lying snow: 'auto' follows the weather's temperature and snowfall (src/sky/groundSnow.ts). */
  groundSnowMode: GroundSnowMode = 'auto';
  readonly groundSnow = new GroundSnowState();
  /** jump straight to the target cover (a new flight, a changed setting) instead of easing */
  private snapSnow = true;
  setGroundSnow(mode: GroundSnowMode): void { this.groundSnowMode = mode; this.snapSnow = true; }
  /** Vegetation season: 'auto' from the date and latitude, or forced. */
  seasonMode: SeasonMode = 'auto';
  private snapSeason = true;
  setSeason(mode: SeasonMode): void { this.seasonMode = mode; this.snapSeason = true; }

  /** Carburettor ice (carburetted engines): see carbIce.ts. */
  readonly carbIce = new CarbIce();
  private carbIceWarned = false;
  get carburetted(): boolean { const e = this.config.propulsion.engine; return e.type === 'piston' && !!e.carburettor; }
  private applyCarbIce(simDt: number, forced: boolean): void {
    const st = this.fdm.state, e = this.effective, w = this.weather.state;
    if (simDt > 0) {
      this.carbIce.update(simDt, {
        oatC: st.atmosphere.temperatureK - 273.15, humidity: w.humidity, visibleMoisture: this.inVisibleMoisture(st.altitudeMslM),
        throttle: e.throttle, carbHeat: e.carbHeat, rpm: st.engine.rpm, forced,
      });
    }
    e.throttle = this.carbIce.throttle(e.throttle, e.carbHeat);
    if (this.carbIce.starved) e.mixture = 0;
    // a pilot notices the rpm creeping down: one hint per icing episode
    if (!this.carbIceWarned && this.carbIce.ice > 0.3 && !e.carbHeat) {
      this.carbIceWarned = true;
      this.events.emit('ui:toast', { text: 'RPM dropping, engine running rough: carburettor ice? Pull carb heat (H).', kind: 'warn', durationMs: 7000 });
    } else if (this.carbIceWarned && this.carbIce.ice < 0.05) this.carbIceWarned = false;
  }
  /** In cloud (a layer of ≥ 50 % cover) or in precipitation. */
  private inVisibleMoisture(altMslM: number): boolean {
    const w = this.weather.state;
    if (w.precipitationRate > 0 && w.precipitationType !== 'none' && windscreenRain(w, altMslM) > 0) return true;
    return w.clouds.some((c) => c.coverage >= 0.5 && c.type !== 'cirrus' && altMslM >= c.baseM && altMslM <= c.topM);
  }

  private cdiHintT = 0;
  private cdiHinted = false;
  /**
   * NAV armed with the G1000's CDI on GPS, no flight plan and a VOR on NAV1: as on the real panel the
   * autopilot has nothing to capture until the CDI is switched to VOR1. Say so once (after 5 s).
   */
  /** The keyboard key bound to `action` (the laptop key before a numpad one), or `fallback`. */
  private keyLabel(action: string, fallback: string): string {
    try {
      const keys = this.input.bindingsList().find((b) => b.action === action)?.labels ?? [];
      return keys.find((k) => !/num/i.test(k)) ?? keys[0] ?? fallback;
    } catch { return fallback; }
  }

  /**
   * The most common first-flight snag: full power against the parking brake (the aircraft starts with
   * it set). After 3 s at high power without moving, say once how to release it.
   */
  private hintParkingBrake(dt: number): void {
    const s = this.fdm.state, e = this.effective;
    if (!e.parkingBrake) { this.brakeHinted = false; this.brakeHintT = 0; return; }
    const stuck = this.inFlight && !this.paused && !this.replayer.active && !this.slew && s.onGround && s.engine.running && e.throttle > 0.7 && s.groundSpeedMs < 1;
    this.brakeHintT = stuck ? this.brakeHintT + dt : 0;
    if (this.brakeHintT > 3 && !this.brakeHinted) {
      this.brakeHinted = true;
      this.events.emit('ui:toast', { text: `The parking brake is set. Press ${this.keyLabel('parkingBrakeToggle', 'Ctrl+.')} to release it.`, kind: 'info', durationMs: 7000 });
    }
  }
  private brakeHintT = 0;
  private upsetT = 0;
  private upsetHinted = false;

  /**
   * With crash damage off (the default assists) a crash is ignored: a nose-in or a cartwheel can
   * leave the aircraft on its back or its nose, where nothing short of a restart helps. After 3 s
   * there, stopped, say how to restart (once until it is upright and moving again).
   */
  private hintUpset(dt: number): void {
    const s = this.fdm.state;
    const roll = Math.abs(s.euler[0]), pitch = s.euler[1];
    const upset = this.inFlight && !this.paused && !this.replayer.active && !this.slew && !s.crashed
      && s.altitudeAglM < 3 && s.groundSpeedMs < 3 && (roll > 60 * DEG || pitch < -30 * DEG || pitch > 50 * DEG);
    this.upsetT = upset ? this.upsetT + dt : 0;
    if (!upset && s.groundSpeedMs > 5) this.upsetHinted = false;
    if (this.upsetT > 3 && !this.upsetHinted) {
      this.upsetHinted = true;
      const what = roll > 90 * DEG ? 'The aircraft has flipped over' : pitch < 0 ? 'The aircraft is stuck on its nose' : 'The aircraft is stuck on its tail';
      this.events.emit('ui:toast', { text: `${what}. Press ${this.keyLabel('resetFlight', 'Ctrl+;')} to restart the flight, or Esc for the menu.`, kind: 'warn', durationMs: 10000 });
    }
  }
  /** first-flights controls tip, shown once the flight is running and visible */
  private tipPending: 'ground' | 'air' | null = null;

  /** The first few flights open with a one-line controls tip (counted in localStorage). */
  private showFlightTip(): void {
    const kind = this.tipPending;
    if (!kind || this.paused || !this.inFlight || this.replayer.active || this.plugins.ui?.coversView?.()) return;
    this.tipPending = null;
    const store = safeLocalStorage();
    let n = 0;
    try { n = Number(store?.getItem(TIP_COUNT_KEY) ?? 0) || 0; store?.setItem(TIP_COUNT_KEY, String(n + 1)); } catch { /* private mode: show it */ }
    if (n >= TIP_FLIGHTS) return;
    const help = this.keyLabel('toggleHelp', '?').replace(/^Shift\+\/$/, '?');
    const text = kind === 'ground'
      ? `Arrow keys fly and steer · Page Up / Page Down: throttle · ${this.keyLabel('parkingBrakeToggle', 'Ctrl+.')}: parking brake · ${help}: all controls`
      : `Arrow keys fly · Page Up / Page Down: throttle · ${this.keyLabel('apToggle', 'Z')}: autopilot · ${help}: all controls`;
    this.events.emit('ui:toast', { text, kind: 'info', durationMs: 12000 });
  }
  private brakeHinted = false;

  private hintCdiSource(dt: number): void {
    const ap = this.autopilot, n1 = this.radios.state.nav1;
    const stuck = this.hasAutopilot && ap.state.armedLateral === 'NAV' && ap.navSource === 'gps' && !this.plan && n1.valid && !n1.isLocalizer;
    this.cdiHintT = stuck ? this.cdiHintT + dt : 0;
    if (!stuck) { if (ap.state.armedLateral !== 'NAV') this.cdiHinted = false; return; }
    if (this.cdiHintT > 5 && !this.cdiHinted) {
      this.cdiHinted = true;
      this.events.emit('ui:toast', { text: `NAV is armed on GPS, but there is no flight plan. To fly ${n1.ident || 'the VOR'}, press CDI on the PFD to select VOR1.`, kind: 'info', durationMs: 8000 });
    }
  }

  /** Failures in effect (failures panel, random failures); cleared by a new flight. */
  readonly failures: Partial<Record<FailureId, boolean>> = {};
  /** Random failures (Settings): about one failure per `RANDOM_FAILURE_MTBF_S` of flying, airborne only. */
  randomFailures = false;
  private failureRng = mulberry32(0x5eed);

  /** Fail or repair a system; announced by toast. */
  setFailure(id: FailureId, failed: boolean): void {
    if (!!this.failures[id] === failed) return;
    if (failed) this.failures[id] = true; else delete this.failures[id];
    this.events.emit('ui:toast', { text: failed ? `Failure: ${FAILURE_LABELS[id]}` : `Repaired: ${FAILURE_LABELS[id]}`, kind: failed ? 'warn' : 'info', durationMs: 5000 });
  }

  /** Repair everything. */
  clearFailures(): void { for (const k of Object.keys(this.failures) as FailureId[]) delete this.failures[k]; }

  private rollRandomFailure(simDt: number): void {
    if (this.fdm.state.onGround) return;
    if (this.failureRng() >= simDt / RANDOM_FAILURE_MTBF_S) return;
    const candidates = FAILURE_IDS.filter((id) => !this.failures[id] && (id !== 'carbIce' || this.carburetted));
    if (!candidates.length) return;
    // engine failures are rarer than instrument or electrical ones
    const weighted = candidates.flatMap((id) => (id === 'engine' ? [id] : [id, id, id]));
    this.setFailure(weighted[Math.floor(this.failureRng() * weighted.length)], true);
  }

  private physicsStep(h: number): void {
    const s = this.fdm.state;
    const env = this.world.env;
    // a terrain tile under the aircraft got new heights (pavement flattened, a finer LOD, a late
    // first tile): an aircraft standing on the ground moves with it instead of being launched or
    // having its gear driven into the ground
    const shift = this.world.groundShift(s.posNED[0], s.posNED[1]);
    if (shift !== 0 && s.onGround) { this.shiftNED[2] = shift; this.fdm.rebase(NO_ROTATION, this.shiftNED); }
    env.surface = this.world.surfaceAt(s.posNED[0], s.posNED[1]);
    const w = this.weather.state;
    env.qnhPa = w.qnhPa;
    env.deltaTisaK = w.temperatureC - 15;
    env.turbulence.intensity = w.turbulence;
    env.turbulence.w20Kt = 0;
    if (this.assists.unlimitedFuel && s.fuelKg.some((f, i) => f < this.config.mass.tanks[i].capacityKg - 1)) this.fdm.setFuelFraction(1);
    this.fdm.step(h, this.effective, env);
    if (s.crashed) {
      // crash damage off (MSFS assist): ignore the crash and carry on
      if (!this.assists.crashDamage && crashIsRecoverable(this.fdm.crashReason)) this.fdm.clearCrash();
      else if (!this.crashReported) {
        this.crashReported = true;
        this.events.emit('aircraft:crash', { reason: this.fdm.crashReason || 'impact' });
      }
    } else if (this.assists.stressDamage) {
      const why = this.stress.check(h, s, this.config.limits);
      if (why) this.fdm.failStructure(why);
    }
    this.touchdown.step(h, s);
    // activity objectives see the pilot's own inputs (hands-off checks must not see the autopilot)
    this.activities.update(h, s, this.input.controls);
    this.replay.record(h, s, this.effective);
    const t = this.world.maybeRebase(s.posNED);
    if (t) this.applyRebase(t);
  }

  /** Re-express everything in the new floating-origin frame after the world rebased. */
  private applyRebase(t: RebaseTransform): void {
    this.fdm.rebase(t.rotation, t.translationNED);
    const shift = nedToThree(t.translationNED, this.v3);
    this.tmpV.set(shift[0], shift[1], shift[2]);
    this.sky.notifyRebase(this.tmpV);
    this.weather.notifyRebase(shift[0], shift[2]);
    this.cameras.shiftOrigin(this.tmpV.clone().negate());
    // keep the replay: re-express its recorded poses in the new frame (clearing it threw away the
    // history every 20 km, so a landing just after a rebase had little or nothing to replay)
    const R = t.rotation, tr = t.translationNED, Rc = qConj(R);
    const pv: [number, number, number] = [0, 0, 0], pq: [number, number, number, number] = [1, 0, 0, 0];
    this.replay.rebase((v) => qRotate(R, [v[0] - tr[0], v[1] - tr[1], v[2] - tr[2]], pv), (q) => qMul(q, Rc, pq));
    copyPose(this.fdm.state, this.prev);
    this.plugins.scenery?.setFrame(this.world.frame);
    this.events.emit('frame:rebased', { frame: this.world.frame.info, translationNED: t.translationNED, rotation: t.rotation });
  }

  // ─────────────────────────────── slew ───────────────────────────────

  private readonly groundUp = (n: number, e: number): number => this.world.env.groundHeight(n, e);
  private readonly shiftNED: [number, number, number] = [0, 0, 0];
  private readonly slewIn = { pitch: 0, roll: 0, yaw: 0, throttle: SLEW_THROTTLE_CENTRE };

  /** Enter or leave slew mode (Y). Leaving restarts the flight model where the aircraft now is. */
  setSlew(on: boolean): void {
    if (on === this.slew) return;
    const c = this.input.controls;
    if (on) {
      if (!this.inFlight || this.replayer.active) return;
      this.slewCtl.enter(this.fdm.state, c.throttle);
      c.throttle = SLEW_THROTTLE_CENTRE; // centred lever = hold altitude
      this.autopilot.engage(false);
      this.slew = true;
      return;
    }
    this.slew = false;
    const sl = this.slewCtl;
    sl.exit();
    const qnh = this.fdm.state.qnhSetPa;
    const onGround = sl.aglM < 10; // hovering just above the ground (e.g. positioned over a runway): set it down
    c.throttle = sl.entryThrottle;
    const minAirspeed = this.config.limits.Vs1Kt * 1.4 * KT;
    const spawn: SpawnState = {
      geo: { lat: sl.geo.lat, lon: sl.geo.lon, alt: onGround ? sl.geo.alt - sl.restAglM : sl.geo.alt },
      headingRad: wrapTwoPi(sl.heading),
      speedMs: onGround ? 0 : Math.max(sl.entrySpeedMs, minAirspeed),
      onGround,
      engineRunning: sl.engineRunning,
    };
    this.fdm.clearCrash();
    this.fdm.reset(spawn, this.world.env);
    this.world.groundShift(this.fdm.state.posNED[0], this.fdm.state.posNED[1]); // reference at the new spot
    this.flightAssists.reset();
    if (!onGround) {
      this.fdm.snapControls(c);
      const a = this.fdm.state.atmosphere;
      this.fdm.trim(casFromTas(spawn.speedMs, a.pressurePa, a.speedOfSound), 0, this.world.env);
      const tr = this.fdm.trimResult;
      if (tr) { c.throttle = tr.throttle; c.pitchTrim = tr.pitchTrim; }
      // the rigging balances the roll at cruise power only: trim the ailerons for this power and speed
      if (tr?.ok) this.trimLateral(c);
    }
    this.fdm.setAltimeter(qnh);
    copyPose(this.fdm.state, this.prev);
    this.loop.reset();
    this.touchdown.reset(onGround);
    this.replay.clear();
  }

  /** One display frame of slew: move with the pilot's controls, keep the floating origin near, show the pose. */
  private slewFrame(dt: number): void {
    const sdt = this.paused ? 0 : dt;
    const u = this.slewIn, c = this.input.controls, o = this.overrides;
    const hold = this.cameras.state.mode === 'drone'; // the stick flies the drone
    u.pitch = hold ? 0 : o.pitch ?? c.pitch;
    u.roll = hold ? 0 : o.roll ?? c.roll;
    u.yaw = hold ? 0 : o.yaw ?? c.yaw;
    u.throttle = hold ? SLEW_THROTTLE_CENTRE : o.throttle ?? c.throttle;
    this.slewCtl.update(sdt, u, this.world.frame, this.groundUp);
    const t = this.world.maybeRebase(this.slewCtl.positionNED(this.world.frame));
    if (t) this.applyRebase(t);
    this.slewCtl.writeState(this.interp, this.world.frame);
    // the clock keeps running while slewing
    this.time.utcMs += sdt * this.time.timeScale * 1000;
    this.time.simTimeS += sdt * this.time.timeScale;
  }

  /**
   * AI pattern traffic: every 5 s re-pick the airport (the spawn airport, or the nearest one
   * within 8 km of the aircraft) and the runway into the wind; every frame advance it on simulated
   * time (frozen while paused, slewing or in replay) and draw it in the current frame.
   */
  private updateTraffic(dt: number, s: AircraftState): void {
    this.trafficTimer += dt;
    if (this.trafficTimer > 5) {
      this.trafficTimer = 0;
      let ap = this.inFlight ? this.currentAirport : null;
      const near = this.nearbyAirports[0];
      if (this.inFlight && near && greatCircleDistance(s.geo, near.position) < 8000) ap = near;
      else if (ap && greatCircleDistance(s.geo, ap.position) > 15000) ap = null;
      const w = this.weather.state.winds[0];
      this.traffic.setAirport(ap, w?.directionDeg ?? 0, w?.speedKt ?? 0, ap === this.currentAirport ? this.spawnRunwayIdent : null);
      // ground traffic needs the OSM stands and taxiways (scenery plugin); stands are queried once per airport
      const query = this.plugins.scenery?.parkingSpots;
      if (ap && query && this.trafficStandsFor !== ap.icao) {
        this.trafficStandsFor = ap.icao;
        this.trafficStands = [];
        const icao = ap.icao;
        query.call(this.plugins.scenery, ap.position.lat, ap.position.lon, 3000).then((sp) => { if (this.trafficStandsFor === icao) this.trafficStands = sp; }).catch(() => {});
      }
      this.traffic.setGround(ap && this.trafficStands.length ? this.ensureTaxiGraph(ap) : null, this.trafficStands, s.geo);
    }
    this.traffic.setCamera(this.cameras.positionThree());
    this.traffic.update(this.lastSimDt, dt, s, this.world.frame, this.sky.sun.elevationRad);
    // traffic advisories on the ATC channel (once a second while flying; not in replay or slew)
    this.advisoryTimer += dt;
    if (this.advisoryTimer >= 1 && this.inFlight && !this.replayer.active && !this.slew) {
      this.advisoryTimer = 0;
      const tr = this.traffic.targets();
      if (tr.length) {
        const calls = this.trafficAdvisor.check(this.time.simTimeS, { lat: s.geo.lat, lon: s.geo.lon, altMslM: s.altitudeMslM, headingDeg: s.headingTrueRad * RAD, onGround: s.onGround }, tr, radioCallsign(this.config).callsign, this.traffic.runway?.side ?? 'left');
        for (const text of calls) { this.events.emit('atc:message', { from: 'atc', text }); this.speakAtc?.(text); }
      }
    }
  }

  /**
   * Taxi-ribbon assist: while on the ground and slow at an airport with OSM taxiways, route along
   * the taxiways to the hold-short point of the runway in use (the one most into the wind, as the
   * AI traffic uses) every 2 s and draw the ribbon; hide it at the hold-short point and in the air.
   */
  /**
   * ATC taxi clearances (AtcControllerOptions.taxiRoute): the taxiway names from the aircraft to the
   * hold-short point of `runwayIdent` at `icao`, or null without an OSM taxi route. The taxi ribbon
   * then leads to that runway.
   */
  atcTaxiVia(icao: string, runwayIdent: string): string[] | null {
    const ap = this.currentAirport?.icao === icao ? this.currentAirport : this.nav.getAirport(icao);
    if (!ap) return null;
    const g = this.ensureTaxiGraph(ap);
    const r = g ? rankRunways(ap, 0, 0).find((x) => x.ident === runwayIdent) : undefined;
    const hs = g && r ? g.holdShort({ threshold: r.threshold, end: r.end, widthM: r.widthM }) : null;
    const st = this.fdm.state;
    const route = hs ? g!.route(st.geo.lat, st.geo.lon, hs) : null;
    if (!route) return null;
    this.clearedRunway = { icao, ident: runwayIdent };
    this.taxiTimer = Infinity; // re-route the ribbon to the cleared runway now
    return route.via;
  }

  /**
   * ATC sequencing (AtcControllerOptions.trafficAhead): the AI aircraft ahead of the player in the
   * landing sequence to `runwayIdent`, when that is the runway the AI traffic circuit uses.
   */
  atcTrafficAhead(icao: string, runwayIdent: string): { type: string; leg: string } | null {
    const r = this.traffic.runway, ap = this.currentAirport;
    if (!r || !ap || ap.icao !== icao) return null;
    const end = rankRunways(ap, 0, 0).find((x) => x.ident === runwayIdent);
    if (!end || greatCircleDistance({ lat: r.lat, lon: r.lon, alt: 0 }, end.threshold) > 300) return null;
    const g = this.fdm.state.geo;
    return this.traffic.aheadOf(g.lat, g.lon);
  }

  /** The OSM taxiway graph of an airport (rebuilt when the airport or the scenery's pavement changes). */
  private ensureTaxiGraph(ap: Airport): TaxiGraph | null {
    const sc = this.plugins.scenery;
    if (!sc?.pavementAreas) { this.taxiGraph = null; return null; }
    const key = `${ap.icao}:${sc.pavementRevision?.() ?? 0}`;
    if (key !== this.taxiGraphKey) {
      this.taxiGraphKey = key;
      const lines = (sc.pavementAreas() as readonly { kind: string; line: number[]; ref?: string }[])
        .filter((a) => a.kind === 'taxiline' && a.line.length >= 4 && greatCircleDistance(ap.position, { lat: a.line[1], lon: a.line[0], alt: 0 }) < 4000);
      this.taxiGraph = lines.length ? new TaxiGraph(ap.position.lat, ap.position.lon, lines) : null;
    }
    return this.taxiGraph;
  }

  private updateTaxiRibbon(dt: number, s: AircraftState): void {
    const ap = this.currentAirport;
    const sc = this.plugins.scenery;
    const want = this.assists.taxiRibbon && this.inFlight && s.onGround && s.groundSpeedMs < 30 * KT && !this.replayer.active && !this.slew && !!ap && !!sc?.pavementAreas;
    if (!want) { if (this.taxiRibbon.visible) this.taxiRibbon.setRoute(null); this.taxiRibbon.setVisible(false); this.taxiTimer = Infinity; return; }
    this.taxiTimer += dt;
    if (this.taxiTimer > 2) {
      this.taxiTimer = 0;
      this.ensureTaxiGraph(ap!);
      const w = this.weather.state.winds[0];
      // the runway in use, or the next best one the taxiways from here actually reach
      let rwy: Runway | null = null, route: TaxiRoute | null = null;
      if (this.taxiGraph) {
        const ranked = rankRunways(ap!, w?.directionDeg ?? 0, w?.speedKt ?? 0, this.spawnRunwayIdent);
        // the runway ATC cleared us to comes first
        const cl = this.clearedRunway?.icao === ap!.icao ? this.clearedRunway.ident : null;
        if (cl) ranked.sort((a, b) => Number(b.ident === cl) - Number(a.ident === cl));
        for (const r of ranked) {
          const hs = this.taxiGraph.holdShort({ threshold: r.threshold, end: r.end, widthM: r.widthM });
          const rt = hs ? this.taxiGraph.route(s.geo.lat, s.geo.lon, hs) : null;
          if (rt) { rwy = r; route = rt; break; }
        }
      }
      if (route && rwy && route.lengthM > 20) {
        this.taxiRibbon.setRoute(route.geo);
        this.taxiRoute = { runway: rwy.ident, via: route.via, lengthM: route.lengthM };
        const ann = `${ap!.icao}:${rwy.ident}`;
        if (this.taxiAnnounced !== ann) {
          this.taxiAnnounced = ann;
          this.events.emit('ui:toast', { text: `Taxi to runway ${rwy.ident}${route.via.length ? ` via ${route.via.join(', ')}` : ''}: follow the blue ribbon.`, kind: 'info', durationMs: 7000 });
        }
      } else {
        // at the hold-short point (or no taxiway route here): no ribbon
        if (route && rwy && this.taxiRoute) this.events.emit('ui:toast', { text: `Hold short of runway ${rwy.ident}.`, kind: 'info', durationMs: 5000 });
        this.taxiRibbon.setRoute(null);
        this.taxiRoute = null;
      }
    }
    this.taxiRibbon.setVisible(true);
    this.taxiRibbon.update(this.world.frame, (n, e) => this.world.groundHeight(n, e));
  }

  private updateVisuals(dt: number, inp: InputSnapshot): void {
    const s = this.interp;
    const cockpit = this.cameras.state.mode === 'cockpit';
    // aircraft pose in the render frame
    nedToThree(s.posNED, this.v3);
    this.posThree.set(this.v3[0], this.v3[1], this.v3[2]);
    bodyQuatToThree(s.qNB, this.qThree);
    this.model.setPose(this.posThree, this.qThree);
    this.model.update(s, this.effective, dt, cockpit);
    this.model.setVisibility(true, cockpit);
    // the wheel arrives as zoomIn/zoomOut actions; the sticky cameraZoom level would make the
    // camera (which reads the axis as a rate) zoom forever
    inp.axes.cameraZoom = 0;
    this.cameras.update(dt, s, this.posThree, this.qThree, inp, this.model.eyePointLocal);
    const camPos = this.cameras.positionThree();
    let tm = performance.now();

    // weather, sky and world
    this.weather.update(dt * (this.paused ? 0 : this.time.timeScale), { tasMs: s.aero.tas, altMslM: s.altitudeMslM, aglM: s.altitudeAglM });
    this.sky.update({ time: this.time, aircraft: s, weather: this.weather.state, frame: this.world.frame.info }, camPos, dt);
    this.model.setSunElevation(this.sky.sun.elevationRad);
    this.model.setRain(windscreenRain(this.weather.state, s.altitudeMslM));
    const L = this.sky.lighting;
    // the sky's ambient irradiance is in the same light units as the terrain shading
    this.terrain?.setSun(L.sunDirThree, L.sunColor, L.sunIntensity, L.ambientIrradiance);
    this.terrain?.setFog(L.fogColor, L.fogDensity, L.fogHeightFalloff, L.sunGlowColor);
    const snow = this.groundSnow.update(groundSnowFor(this.weather.state, this.groundSnowMode), dt * (this.paused ? 0 : this.time.timeScale), this.snapSnow);
    this.snapSnow = false;
    this.terrain?.setSnow(snow.lineM, snow.amount);
    this.plugins.scenery?.setSnow?.(snowAt(snow, s.altitudeMslM - s.altitudeAglM));
    const conv = convectionFor(this.weather.state, this.sky.sun.elevationRad, s.altitudeMslM - s.altitudeAglM, snowAt(snow, s.altitudeMslM - s.altitudeAglM));
    this.world.verticalAir.setConvection(conv.strength, conv.topAglM);
    if ((this.frameCount & 63) === 0 || this.snapSeason) {
      // the date and latitude change slowly: every 64 frames is plenty
      this.snapSeason = false;
      const sea = this.seasonMode === 'auto' ? seasonFor(this.time.utcMs, s.geo.lat) : SEASON_PRESETS[this.seasonMode];
      this.terrain?.setSeason(sea.autumn, sea.dormant);
      this.plugins.scenery?.setSeason?.(sea.autumn, sea.dormant);
    }
    let tn = performance.now(); this.mark('sky', tn - tm); tm = tn;
    this.world.update(dt, camPos, this.cameras.camera, s.geo, this.v3, this.sky.sun.elevationRad, dt * (this.paused ? 0 : this.time.timeScale));
    this.plugins.scenery?.update(dt, camPos, this.cameras.camera, this.sky.sun.elevationRad);
    this.landingGuide.update(dt, this.assists.landingPathHints && this.inFlight && !this.replayer.active && !this.slew, s.geo, s.trackRad * RAD, s.onGround, this.nearbyAirports, this.world.frame);
    this.updateTraffic(dt, s);
    this.hintCdiSource(dt);
    this.hintParkingBrake(dt);
    this.hintUpset(dt);
    this.showFlightTip();
    if (this.inFlight && !this.paused && !this.replayer.active && !this.slew) {
      if ((this.frameCount & 31) === 0) this.logNearest = this.airportNear(s.geo.lat, s.geo.lon);
      // the flight model's own clock: time actually flown (time acceleration on a slow machine falls behind the wall clock)
      const tNow = this.fdm.state.t, flown = tNow - this.logLastT;
      this.logLastT = tNow;
      this.logRecorder.update({
        dtS: flown > 0 && flown < 10 ? flown : 0, utcMs: this.time.utcMs, onGround: s.onGround, lat: s.geo.lat, lon: s.geo.lon, altMslM: s.altitudeMslM,
        groundSpeedMs: s.groundSpeedMs, sunElevationRad: this.sky.sun.elevationRad, crashed: s.crashed, nearestIcao: this.logNearest,
      });
    }
    this.updateTaxiRibbon(dt, s);
    tn = performance.now(); this.mark('world', tn - tm); tm = tn;

    // navigation (radios every frame, nearby airports and magnetic variation slowly)
    this.nearbyTimer += dt;
    if (this.nearbyTimer > 2) { this.nearbyTimer = 0; this.nearbyAirports = this.nav.nearestAirports(s.geo, 12, 40); }
    this.magTimer += dt;
    if (this.magTimer > 30) { this.magTimer = 0; this.magVar = magneticDeclinationDeg(s.geo.lat, s.geo.lon, s.geo.alt, this.time.utcMs); }
    this.radios.update(dt, s.geo, this.magVar);
    this.plan = this.planner.waypoints.length ? this.planner.update(s.geo, s.groundSpeedMs) : null;

    const snap = this.refreshSnapshot();
    // only the panel on display is stepped and redrawn (each has its own instrument model)
    if (this.panelVariant === 'steam') {
      // the steam panel's COM1 windows show the radio stack ATC uses (the G1000 syncs its own box)
      const com = this.radios.state.com1, box = this.steam.com1;
      box.activeKHz = Math.round(com.activeMHz * 1000); box.standbyKHz = Math.round(com.standbyMHz * 1000);
      if (this.steam.update(snap, dt)) this.steamTex.needsUpdate = true;
    }
    else if (this.plugins.g1000?.update(snap, dt) && this.g1000Tex) this.g1000Tex.needsUpdate = true;
    this.plugins.hud?.update(snap, dt);
    this.plugins.audio?.update(dt, s, this.cameras.state, this.weather.state);
    this.plugins.audio?.setMarker?.(this.radios.state.nav1.marker ?? null);
    // ATC follows live flight only: replayed poses and slew teleports would drive its state machine
    if (this.inFlight && !this.replayer.active && !this.slew) this.plugins.atc?.update(dt * (this.paused ? 0 : this.time.timeScale), s, this.weather.state);
    this.plugins.ui?.update(snap, dt);
    if ((this.frameCount & 15) === 0) this.events.emit('terrain:progress', { ready: snap.terrainReady });
    tn = performance.now(); this.mark('instruments', tn - tm); tm = tn;
    // behind an opaque menu, draw the scene only at ~4 Hz (keeps shaders warm, saves the GPU)
    if (!this.plugins.ui?.coversView?.() || (this.frameCount & 15) === 0) this.postFx.render(this.scene, this.cameras.camera);
    if (this.screenshotPending) { this.screenshotPending = false; this.saveScreenshot(); }
    this.mark('render', performance.now() - tm);
  }

  // ─────────────────────────────── actions ───────────────────────────────

  /** Simulator-level handling of discrete actions (keyboard, gamepad, UI buttons). */
  handleAction(a: SimAction): void {
    if (this.radios.handleAction(a)) return;
    if (this.plugins.ui?.handleAction?.(a)) return;
    // AP keys and the heading bug do nothing in an aircraft without an autopilot (and directional gyro)
    if (!this.hasAutopilot && AP_ACTIONS.has(a)) return;
    const ap = this.autopilot, aps = ap.state, s = this.fdm.state;
    switch (a) {
      case 'pause': this.setPaused(!this.paused); break;
      case 'toggleHud': this.hudVisible = !this.hudVisible; break;
      case 'timeFaster': this.time.timeScale = Math.min(this.time.timeScale * 2, 16); this.events.emit('time:changed', { state: this.time }); break;
      case 'timeSlower': this.time.timeScale = Math.max(this.time.timeScale / 2, 0.25); this.events.emit('time:changed', { state: this.time }); break;
      case 'timeNormal': this.time.timeScale = 1; this.events.emit('time:changed', { state: this.time }); break;
      case 'timeDawn': this.setTimePreset('dawn'); break;
      case 'timeNoon': this.setTimePreset('noon'); break;
      case 'timeDusk': this.setTimePreset('dusk'); break;
      case 'timeNight': this.setTimePreset('night'); break;
      case 'resetFlight': case 'activeRunwayRespawn': if (this.lastSpawn) void this.respawn(); break;
      case 'repairRefuel': this.fdm.clearCrash(); this.crashReported = false; this.stress.reset(); this.fdm.setFuelFraction(1); break;
      case 'screenshot': this.screenshotPending = true; break;
      case 'engineAutoStart': if (!s.engine.running) this.autoStartT = 0; break;
      case 'engineShutdown': this.input.controls.mixture = 0; this.input.controls.magnetos = 0; this.events.emit('engine:stopped', { reason: 'shutdown' }); break;
      case 'altimeterInc': this.fdm.setAltimeter(s.qnhSetPa + 0.01 * INHG); break;
      case 'altimeterDec': this.fdm.setAltimeter(s.qnhSetPa - 0.01 * INHG); break;
      // B (MSFS): set the altimeter to the local QNH; pressing it again when already set selects standard
      case 'altimeterStd': this.fdm.setAltimeter(Math.abs(s.qnhSetPa - this.weather.state.qnhPa) < 30 ? 101325 : this.weather.state.qnhPa); break;
      case 'apToggle': ap.engage(!aps.engaged); break;
      case 'fdToggle': ap.press('FD'); break;
      case 'yawDamper': ap.press('YD'); break;
      // GFC 700 panel semantics: toggle back to ROL/PIT, sync targets, disarm an armed mode
      case 'apHdg': ap.press('HDG'); this.ensureAp(); break;
      case 'apNav': ap.press('NAV'); this.ensureAp(); break;
      case 'apApr': ap.press('APR'); this.ensureAp(); break;
      case 'apAlt': ap.press('ALT'); this.ensureAp(); break;
      case 'apVs': ap.press('VS'); this.ensureAp(); break;
      case 'apFlc': ap.press('FLC'); this.ensureAp(); break;
      // real LVL: recovers from any attitude and engages the autopilot itself
      case 'apLvl': ap.press('LVL'); break;
      case 'apHdgInc': case 'headingBugInc': ap.setHeadingBug(aps.headingBugDeg + 1); break;
      case 'apHdgDec': case 'headingBugDec': ap.setHeadingBug(aps.headingBugDeg - 1); break;
      case 'apHdgSync': ap.setHeadingBug(Math.round(s.headingMagRad * RAD)); break;
      case 'apAltInc': ap.setAltitudeTarget(aps.altitudeTargetM + 100 * FT); break;
      case 'apAltDec': ap.setAltitudeTarget(Math.max(0, aps.altitudeTargetM - 100 * FT)); break;
      case 'apAltSync': ap.setAltitudeTarget(Math.round(s.altitudeIndicatedM / FT / 100) * 100 * FT); break;
      case 'apVsInc': ap.setVerticalSpeedTarget(aps.verticalSpeedTargetMs + 100 * FPM); break;
      case 'apVsDec': ap.setVerticalSpeedTarget(aps.verticalSpeedTargetMs - 100 * FPM); break;
      case 'apIasInc': ap.setIasTarget(aps.iasTargetMs + KT); break;
      case 'apIasDec': ap.setIasTarget(aps.iasTargetMs - KT); break;
      case 'assistAutoRudderToggle': this.assists.autoRudder = !this.assists.autoRudder; break;
      case 'assistTakeoffToggle': this.assists.assistedTakeoff = !this.assists.assistedTakeoff; break;
      case 'assistLandingToggle': this.assists.assistedLanding = !this.assists.assistedLanding; break;
      case 'slewToggle': this.setSlew(!this.slew); break;
      default: {
        const m = /^atcOption(\d)$/.exec(a);
        if (m) this.plugins.atc?.select(m[1] === '0' ? 10 : Number(m[1]));
      }
    }
  }

  private ensureAp(): void { if (!this.autopilot.state.engaged) this.autopilot.engage(true); }

  setPaused(p: boolean): void {
    this.paused = p;
    this.loop.reset();
  }

  /** Graphics > Shadows: sun shadow maps on/off (materials recompile once on a change). */
  setShadows(on: boolean): void {
    const r = this.gfx.renderer;
    if (r.shadowMap.enabled === on && this.sky.sunLight.castShadow === on) return;
    r.shadowMap.enabled = on;
    this.sky.sunLight.castShadow = on;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => { x.needsUpdate = true; }); else if (m) m.needsUpdate = true;
    });
  }

  /** Spawn convenience: panel lights on when the sun is below ~3° at the spawn point (off by day). */
  private applyPanelLightsForDaylight(lat: number, lon: number): void {
    const el = sunPosition(this.time.utcMs, lat, lon).elevation;
    this.input.controls.lights.panel = el < 3 ? 1 : 0;
  }

  /** Set the clock to a local solar hour at the aircraft's longitude (keeps the date). */
  setLocalHour(hour: number): void {
    const d = new Date(this.time.utcMs);
    const lon = this.fdm.state.geo.lon || -122.4;
    const utcHour = ((hour - lon / 15) % 24 + 24) % 24;
    this.time.utcMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + utcHour * 3_600_000;
    this.sky.resetAdaptation();
    this.events.emit('time:changed', { state: this.time });
  }

  /**
   * MSFS-style time presets relative to the real sunrise and sunset for today's date at the
   * aircraft: dawn = sunrise + 10 min, morning = sunrise + 2 h, noon = solar noon,
   * afternoon = sunset − 3 h, dusk = sunset − 20 min, night = sunset + 2.5 h.
   */
  setTimePreset(p: 'dawn' | 'morning' | 'noon' | 'afternoon' | 'dusk' | 'night'): void {
    const g = this.fdm.state.geo;
    const lat = g.lat || 37.6, lon = g.lon || -122.4;
    const e = sunEvents(this.time.utcMs, lat, lon);
    const H = 3_600_000;
    const pick = { dawn: e.sunriseMs + H / 6, morning: e.sunriseMs + 2 * H, noon: e.noonMs, afternoon: e.sunsetMs - 3 * H, dusk: e.sunsetMs - H / 3, night: e.sunsetMs + 2.5 * H }[p];
    if (Number.isFinite(pick)) this.time.utcMs = pick;
    else this.setLocalHour({ dawn: 6, morning: 9, noon: 12, afternoon: 15, dusk: 18, night: 22 }[p]);
    this.sky.resetAdaptation();
    // a jump to dusk/night (e.g. an activity setting its time after the spawn) brings the panel lights on
    this.applyPanelLightsForDaylight(lat, lon);
    this.events.emit('time:changed', { state: this.time });
  }

  setWeatherPreset(id: WeatherPresetId, transitionS = 0): void {
    this.weatherPreset = id;
    this.weather.setPreset(id, transitionS);
    this.events.emit('weather:changed', { state: this.weather.state });
  }

  // ─────────────────────────────── spawning ───────────────────────────────

  /** Pick a runway end at an airport: by ident, else the one most into the wind. */
  runwayEndFor(airport: Airport, ident?: string): RunwayEndRef | null {
    const ends = airport.runways.flatMap((r) => runwayEnds(airport, r));
    if (ident) { const e = ends.find((x) => x.ident === ident); if (e) return e; }
    const w = this.weather.state.winds[0];
    const best = w ? runwayInUse(airport, w.directionDeg) : undefined;
    return (best && ends.find((x) => x.ident === best.ident)) ?? ends.sort((a, b) => b.lengthM - a.lengthM)[0] ?? null;
  }

  /** Spawn on a runway (lined up, past the threshold markings) or cold & dark. */
  async spawnAtRunway(airport: Airport, endIdent: string | null, opts: { coldAndDark?: boolean; fuelFraction?: number; payloadKg?: number } = {}): Promise<void> {
    const end = this.runwayEndFor(airport, endIdent ?? undefined);
    const thr = end ? end.threshold : airport.position;
    const hdg = end ? end.headingDeg : 0;
    const pos = World.offset({ lat: thr.lat, lon: thr.lon, alt: end ? thr.alt : airport.elevationM }, hdg, (end?.displacedM ?? 0) + SPAWN_ROLL_OFFSET_M);
    const elev = end ? thr.alt : airport.elevationM;
    this.spawnRunwayIdent = end?.ident ?? null;
    await this.beginFlight(airport, end, { geo: { lat: pos.lat, lon: pos.lon, alt: elev }, headingRad: hdg * DEG, speedMs: 0, onGround: true, engineRunning: !opts.coldAndDark }, opts);
  }

  /**
   * Cold & dark at a parking stand: the nearest gate or apron stand from the OSM scenery (when the
   * scenery plugin and its data are available), else the runway threshold as before.
   */
  async spawnAtParking(airport: Airport, opts: { fuelFraction?: number; payloadKg?: number } = {}): Promise<void> {
    let spot: { lat: number; lon: number; headingDeg: number; name: string } | null = null;
    const query = this.plugins.scenery?.parkingSpots;
    if (query) {
      try {
        const timeout = new Promise<[]>((res) => setTimeout(() => res([]), 6000));
        const spots = await Promise.race([query.call(this.plugins.scenery, airport.position.lat, airport.position.lon, 3000), timeout]);
        // a light aircraft parks on the ramp, as MSFS picks a GA spot: the nearest apron stand, a
        // terminal gate only when the airport has no stands
        spot = spots.find((s) => s.kind !== 'gate') ?? spots[0] ?? null;
      } catch { spot = null; }
    }
    if (!spot) { await this.spawnAtRunway(airport, null, { ...opts, coldAndDark: true }); return; }
    await this.beginFlight(airport, null, { geo: { lat: spot.lat, lon: spot.lon, alt: airport.elevationM }, headingRad: spot.headingDeg * DEG, speedMs: 0, onGround: true, engineRunning: false }, opts);
    this.events.emit('ui:toast', { text: `Parked at ${spot.name || 'the apron'}, ${airport.icao}. Cold & dark: Ctrl+E to start.`, kind: 'info', durationMs: 6000 });
  }

  /** Spawn established on final for a landing challenge. */
  async startChallenge(id: string): Promise<void> {
    const c = LANDING_CHALLENGES.find((x) => x.id === id);
    if (!c) throw new Error(`unknown challenge ${id}`);
    // landing challenges are flown in the 172 (speeds, flap setting and scoring are written for it)
    this.useAircraftFor(LANDING_CHALLENGE_AIRCRAFT);
    await this.nav.load();
    const ap = this.nav.getAirport(c.icao);
    if (!ap) throw new Error(`airport ${c.icao} not in the database`);
    await this.nav.loadRegion(ap.position, 30);
    const end = this.runwayEndFor(ap, c.runway);
    if (!end) throw new Error(`runway ${c.runway} not found at ${c.icao}`);
    this.setWeatherPreset(c.weather);
    if (c.wind) {
      const w = this.weather.state.winds[0];
      if (w) { w.directionDeg = c.wind.fromDeg; w.speedKt = c.wind.speedKt; w.gustKt = c.wind.gustKt; }
    }
    const dist = c.startNm * 1852;
    const p = World.offset(end.threshold, end.headingDeg + 180, dist);
    const alt = end.threshold.alt + 15 + Math.tan(c.glideDeg * DEG) * dist;
    const a = atmosphere(alt);
    const tas = c.speedKt * KT * Math.sqrt(1.225 / a.densityKgM3);
    await this.beginFlight(ap, end, { geo: { lat: p.lat, lon: p.lon, alt }, headingRad: end.headingDeg * DEG, speedMs: tas, onGround: false, engineRunning: true, gammaRad: -c.glideDeg * DEG }, { flapsIndex: 2 });
    this.setTimePreset(c.time);
    this.applyPanelLightsForDaylight(p.lat, p.lon);
  }

  /**
   * Air start (lessons, scripted scenarios): trimmed level (or on `gammaRad`) at a geodetic point,
   * indicated airspeed `iasMs`, true heading `headingDeg`, near the nearest airport's region.
   */
  async spawnInAir(lat: number, lon: number, altM: number, headingDeg: number, iasMs: number, opts: { flapsIndex?: number; gammaRad?: number } = {}): Promise<void> {
    await this.nav.load();
    const geo = { lat, lon, alt: altM };
    await this.nav.loadRegion(geo, 30);
    const airport = this.nav.nearestAirports(geo, 1, 40)[0] ?? null;
    const a = atmosphere(altM);
    const tas = iasMs * Math.sqrt(1.225 / a.densityKgM3);
    await this.beginFlight(airport, null, { geo, headingRad: headingDeg * DEG, speedMs: tas, onGround: false, engineRunning: true, gammaRad: opts.gammaRad ?? 0 }, { flapsIndex: opts.flapsIndex ?? 0 });
  }

  /** Default "Fly now": KSFO 28R. */
  async flyNow(): Promise<void> {
    await this.nav.load();
    const ap = this.nav.getAirport('KSFO');
    if (!ap) throw new Error('KSFO missing from the airport database');
    await this.spawnAtRunway(ap, '28R');
  }

  async respawn(): Promise<void> {
    const l = this.lastSpawn;
    if (!l) return;
    await this.beginFlight(l.airport, l.end, l.spawn, {});
  }

  /**
   * The flight as it is now, for "Save flight": aircraft, exact flight-model state (in its frame),
   * controls, weather, world time and flight plan. Null when no flight is running or it crashed.
   */
  saveFlight(): SavedFlight | null {
    if (!this.inFlight || this.fdm.state.crashed || this.replayer.active) return null;
    const st = this.fdm.state;
    return {
      v: 1, savedAtMs: Date.now(), aircraftId: this.config.id,
      airportIcao: this.currentAirport?.icao ?? null,
      geo: { ...st.geo }, headingRad: st.headingTrueRad, onGround: st.onGround,
      frame: { ...this.world.frame.info }, fdm: this.fdm.serialize(),
      controls: structuredClone(this.input.controls), weather: structuredClone(this.weather.state), utcMs: this.time.utcMs,
      plan: this.planner.waypoints.map((w) => structuredClone(w)), activeLeg: this.planner.activeLeg,
      failures: Object.keys(this.failures) as FailureId[],
      radios: { tuning: this.radios.tuning.map((t) => ({ ...t })), com1: { ...this.radios.state.com1 } },
      autopilot: (({ engaged, flightDirector, yawDamper, lateral, vertical, armedLateral, armedVertical, headingBugDeg, altitudeTargetM, verticalSpeedTargetMs, iasTargetMs }) =>
        ({ engaged, flightDirector, yawDamper, lateral, vertical, armedLateral, armedVertical, headingBugDeg, altitudeTargetM, verticalSpeedTargetMs, iasTargetMs }))(this.autopilot.state),
    };
  }

  /** Resume a saved flight (see `saveFlight`). False when its aircraft is unknown. */
  async restoreFlight(save: SavedFlight): Promise<boolean> {
    if (save.v !== 1 || !aircraftById(save.aircraftId)) return false;
    this.selectAircraft(save.aircraftId);
    await this.nav.load();
    await this.nav.loadRegion(save.geo, 30);
    const airport = (save.airportIcao && this.nav.getAirport(save.airportIcao)) || (this.nav.nearestAirports(save.geo, 1, 40)[0] ?? null);
    this.time.utcMs = save.utcMs;
    this.sky.resetAdaptation();
    this.weather.setState(save.weather, 0);
    this.events.emit('weather:changed', { state: this.weather.state });
    const spawn: SpawnState = { geo: { ...save.geo }, headingRad: save.headingRad, speedMs: 0, onGround: true, engineRunning: true };
    await this.beginFlight(airport, null, spawn, { restore: save });
    // beginFlight re-anchored the weather layers to the airport elevation: the saved state is already anchored
    this.weather.setState(save.weather, 0);
    if (save.plan.length) { this.planner.setWaypoints(save.plan); if (save.activeLeg > 0 && save.activeLeg < save.plan.length) this.planner.activateLeg(save.activeLeg); }
    for (const f of save.failures) if ((FAILURE_IDS as readonly string[]).includes(f)) this.setFailure(f, true);
    if (save.radios) {
      save.radios.tuning.slice(0, 2).forEach((t, i) => {
        const r = this.radios.tuning[i];
        if (Number.isFinite(t.activeKHz)) r.standbyKHz = t.standbyKHz;
        if (Number.isFinite(t.activeKHz)) this.radios.tuneNav(i as 0 | 1, t.activeKHz, t.obsDeg);
      });
      Object.assign(this.radios.state.com1, save.radios.com1);
    }
    const ap = save.autopilot;
    if (ap && this.hasAutopilot) {
      const a = this.autopilot;
      a.setHeadingBug(ap.headingBugDeg); a.setAltitudeTarget(ap.altitudeTargetM);
      a.setVerticalSpeedTarget(ap.verticalSpeedTargetMs); a.setIasTarget(ap.iasTargetMs);
      a.setFlightDirector(ap.flightDirector); a.setYawDamper(ap.yawDamper);
      if (ap.engaged) a.engage(true);
      // modes after engaging (engaging picks default modes); armed modes are re-armed by selecting them
      if (ap.lateral !== 'OFF') a.setLateral(ap.lateral as LateralMode);
      if (ap.vertical !== 'OFF') a.setVertical(ap.vertical as VerticalMode);
      if (ap.armedLateral) a.setLateral(ap.armedLateral as LateralMode);
      if (ap.armedVertical) a.setVertical(ap.armedVertical as VerticalMode);
    }
    return true;
  }

  /**
   * Lateral trim for an air start: the aileron trim that keeps the wings level hands-off at the trimmed
   * power and speed (the C172's bent-tab rigging is set for 105 KCAS cruise; at other power settings
   * the torque no longer balances and, with the auto-rudder holding the ball centred, nothing would
   * stop a slow roll from becoming a spiral). Secant search on the bank after 3 s of flight from the
   * trimmed state, which is restored afterwards.
   */
  private trimLateral(c: ControlInputs): void {
    const env = this.world.env;
    const base = this.fdm.serialize();
    const mixture = this.assists.autoMixture ? Math.min(c.mixture, this.fdm.peakPowerMixture()) : c.mixture;
    const bankAfter = (trim: number): number => {
      this.fdm.deserialize(base);
      const u: ControlInputs = { ...c, mixture, aileronTrim: trim, lights: { ...c.lights } };
      for (let i = 0; i < 3 / PHYSICS_DT; i++) this.fdm.step(PHYSICS_DT, u, env);
      const phi = this.fdm.state.euler[0];
      return Number.isFinite(phi) ? phi : NaN;
    };
    let t0 = clamp(c.aileronTrim ?? 0, -1, 1), f0 = bankAfter(t0);
    let best = { t: t0, f: Math.abs(f0) };
    if (Number.isFinite(f0) && Math.abs(f0) > 0.2 * DEG) {
      let t1 = clamp(t0 - Math.sign(f0) * 0.3, -1, 1), f1 = bankAfter(t1);
      for (let k = 0; k < 4 && Number.isFinite(f1); k++) {
        if (Math.abs(f1) < best.f) best = { t: t1, f: Math.abs(f1) };
        if (Math.abs(f1) < 0.05 * DEG || Math.abs(f1 - f0) < 1e-9) break;
        const t2 = clamp(t1 - (f1 * (t1 - t0)) / (f1 - f0), -1, 1);
        t0 = t1; f0 = f1; t1 = t2; f1 = bankAfter(t1);
      }
      if (Number.isFinite(f1) && Math.abs(f1) < best.f) best = { t: t1, f: Math.abs(f1) };
    }
    this.fdm.deserialize(base);
    c.aileronTrim = best.t;
  }

  /** Common spawn path: new origin, terrain prefetch, airport geometry, flight-model reset, systems reset. */
  private async beginFlight(airport: Airport | null, end: RunwayEndRef | null, spawn: SpawnState, opts: { fuelFraction?: number; payloadKg?: number; flapsIndex?: number; restore?: SavedFlight }): Promise<void> {
    this.inFlight = false;
    this.slew = false;
    this.slewCtl.exit();
    this.paused = true;
    const g = spawn.geo;
    if (airport) await this.nav.loadRegion(airport.position, 40);
    this.currentAirport = airport;
    // a restored flight's state is in its saved frame: the same origin
    const o = opts.restore?.frame;
    this.world.setOrigin(o ? o.lat0 : g.lat, o ? o.lon0 : g.lon, spawn.onGround ? g.alt : airport?.elevationM ?? 0);
    this.plugins.scenery?.setFrame(this.world.frame);
    if (airport) { this.world.airports.ensureAirport(airport); this.world.syncRunways(); }
    // aprons / taxiways known near the spawn (a parking spawn loaded their scenery tiles) are
    // flattened before the prefetch, so the aircraft never starts on ground that is flattened later
    this.world.syncPavement(true);
    this.weather.setAirportElevation(airport?.elevationM ?? 0);
    this.weather.setFrame(this.world.frame.info);
    this.nearbyAirports = this.nav.nearestAirports(g, 12, 40);
    // wait for the ground under the spawn (behind the loading screen; it resolves as soon as the tile
    // is in). A slow connection gets 20 s before the aircraft is placed on whatever ground exists; a
    // later reload under it is ridden out by groundShift in physicsStep.
    if (this.terrain) await Promise.race([this.terrain.prefetch(g.lat, g.lon, 2500), new Promise((r) => setTimeout(r, SPAWN_TERRAIN_WAIT_MS))]);
    // an air start never begins in (or skimming) the terrain: a glide path or a scenic start computed
    // from an airport's elevation can pass under rising ground (KTRK 29 put the aircraft 34 m under it)
    if (!spawn.onGround && !opts.restore) {
      const ground = this.world.groundHeight(0, 0);
      if (ground !== null && Number.isFinite(ground) && g.alt < ground + AIR_SPAWN_MIN_AGL_M) {
        spawn = { ...spawn, geo: { ...g, alt: ground + AIR_SPAWN_MIN_AGL_M } };
      }
    }
    if (opts.fuelFraction !== undefined) this.fdm.setFuelFraction(opts.fuelFraction);
    if (opts.payloadKg !== undefined) {
      let rest = opts.payloadKg;
      const st = this.config.mass.stations.map((s) => { const m = Math.min(rest, s.maxKg); rest -= m; return m; });
      this.fdm.setLoad(st);
    }
    // pilot controls to a sane starting state
    const c = this.input.controls;
    Object.assign(c, defaultControlInputs());
    c.parkingBrake = spawn.onGround;
    c.magnetos = spawn.engineRunning ? 3 : 0;
    c.mixture = spawn.engineRunning ? 1 : 0;
    // cold & dark: master and avionics off (the engine-running spawns have everything on)
    c.masterBattery = spawn.engineRunning; c.masterAlternator = spawn.engineRunning; c.avionicsMaster = spawn.engineRunning; c.fuelPump = false;
    c.flapsIndex = opts.flapsIndex ?? 0;
    c.lights = { nav: true, beacon: spawn.engineRunning, strobe: !spawn.onGround, landing: !spawn.onGround, taxi: spawn.onGround && spawn.engineRunning, panel: 0 };
    this.applyPanelLightsForDaylight(g.lat, g.lon);
    this.fdm.clearCrash();
    this.crashReported = false;
    this.stress.reset();
    this.fdm.reset(spawn, this.world.env);
    // the ground-shift reference is the ground the aircraft was just placed on (not a stale sample from
    // before the spawn), so a reload in the frame before the first physics step is not missed
    this.world.groundShift(this.fdm.state.posNED[0], this.fdm.state.posNED[1]);
    if (!spawn.onGround) {
      // trim with the approach flaps already set (not a flap motor that has barely started moving)
      // trim with the mixture the engine will actually run on: the auto-mixture assist leans to peak power
      // (at altitude a full-rich trim saturates the throttle, then the leaned engine climbs away)
      this.fdm.snapControls(this.assists.autoMixture && spawn.engineRunning ? { ...c, mixture: Math.min(c.mixture, this.fdm.peakPowerMixture()) } : c);
      const cas = casFromTas(spawn.speedMs, this.fdm.state.atmosphere.pressurePa, this.fdm.state.atmosphere.speedOfSound);
      this.fdm.trim(cas, spawn.gammaRad ?? 0, this.world.env);
      const tr = this.fdm.trimResult;
      if (tr) { c.throttle = tr.throttle; c.pitchTrim = tr.pitchTrim; }
      if (tr?.ok && !opts.restore) this.trimLateral(c);
    }
    this.fdm.setAltimeter(this.weather.state.qnhPa);
    if (opts.restore) {
      // the exact saved state (attitude, rates, fuel, engine temperatures, flaps, trim, battery) over the placeholder spawn
      this.fdm.deserialize(opts.restore.fdm);
      Object.assign(c, structuredClone(opts.restore.controls));
      this.fdm.snapControls(c);
      this.world.groundShift(this.fdm.state.posNED[0], this.fdm.state.posNED[1]);
    }
    copyPose(this.fdm.state, this.prev);
    this.loop.reset();
    // power-on state (FD/YD off, modes and trim cleared) without a disconnect tone
    this.autopilot.reset();
    this.flightAssists.reset();
    this.autopilot.setHeadingBug(Math.round(this.fdm.state.headingMagRad * RAD));
    this.autopilot.setAltitudeTarget(Math.round((this.fdm.state.altitudeMslM + 3000 * FT) / (100 * FT)) * 100 * FT);
    this.touchdown.reset(spawn.onGround);
    this.replay.clear();
    this.planner.clear();
    this.plugins.atc?.reset(airport);
    this.cameras.setTowerPosition(this.tmpV.set(-250, 25, 120));
    this.cameras.snapToAircraft();
    this.lastSpawn = { airport, spawn, end };
    this.inFlight = true;
    this.tipPending = spawn.onGround ? 'ground' : 'air';
    this.trafficTimer = Infinity; // traffic for the new airport on the first frame of the flight
    this.trafficAdvisor.reset();
    this.clearedRunway = null;
    this.clearFailures();
    this.carbIce.reset();
    // magnetic variation of the new position now, not up to 30 s later: a localizer tuned right after
    // the spawn takes its auto-course from it (the first value came from the pre-flight state at 0°, 0°,
    // −4°, so a KSFO ILS was set 17° off and the autopilot could not centre the localizer)
    this.magVar = magneticDeclinationDeg(this.fdm.state.geo.lat, this.fdm.state.geo.lon, this.fdm.state.geo.alt, this.time.utcMs);
    this.magTimer = 0;
    this.snapSnow = true;
    // the previous flight goes into the logbook; this one starts recording
    this.logNearest = this.airportNear(g.lat, g.lon);
    this.logLastT = this.fdm.state.t;
    const logged = this.logRecorder.begin({ utcMs: this.time.utcMs, aircraftId: this.config.id, aircraftName: this.config.name, onGround: spawn.onGround, nearestIcao: this.logNearest });
    if (logged) this.logbook.add(logged);
    this.paused = false;
    this.resetInstruments();
    this.events.emit('flight:reset', { spawn });
  }

  // ─────────────────────────────── snapshot ───────────────────────────────

  private buildSnapshot(): SimSnapshot {
    return {
      time: this.time, aircraft: this.interp, inputs: this.effective, weather: this.weather.state, sun: this.sky.sun,
      camera: this.cameras.state, autopilot: this.autopilot.state, nav1: this.radios.nav1, nav2: this.radios.nav2,
      plan: null, frame: this.world.frame.info, paused: this.paused, slew: this.slew, assists: this.assists, terrainReady: 0, fps: 0,
    };
  }

  private refreshSnapshot(): SimSnapshot {
    const sn = this.snapshot;
    sn.aircraft = this.interp;
    sn.weather = this.weather.state;
    sn.plan = this.plan;
    sn.frame = this.world.frame.info;
    sn.paused = this.paused || !this.inFlight;
    sn.slew = this.slew;
    sn.assists = this.assists;
    sn.terrainReady = this.terrain ? this.terrain.readyFraction(this.cameras.positionThree()) : 1;
    sn.fps = this.fps;
    const tr = this.traffic.targets();
    sn.traffic = tr.length ? tr : undefined;
    sn.failures = Object.keys(this.failures).length ? this.failures : undefined;
    return sn;
  }

  /** Airports within ~40 nm of the aircraft (refreshed every 2 s). */
  get nearby(): readonly Airport[] { return this.nearbyAirports; }

  /** Latest physics state (not interpolated). */
  get aircraft(): AircraftState { return this.fdm.state; }

  /** Run the physics as fast as possible for `seconds` of sim time (automation/tests); no rendering. */
  advance(seconds: number): void {
    const n = Math.round(seconds / PHYSICS_DT);
    for (let i = 0; i < n && !this.fdm.state.crashed; i++) {
      // navigation (radios, flight-plan guidance) as the display frames would update it: the autopilot's
      // NAV / APR modes read them (without this, fast-forwarded flights flew with no plan or signal)
      if (i % 12 === 0) {
        const s = this.fdm.state, ndt = Math.min(12, n - i) * PHYSICS_DT;
        this.magTimer += ndt;
        if (this.magTimer > 30) { this.magTimer = 0; this.magVar = magneticDeclinationDeg(s.geo.lat, s.geo.lon, s.geo.alt, this.time.utcMs); }
        this.radios.update(ndt, s.geo, this.magVar);
        this.plan = this.planner.waypoints.length ? this.planner.update(s.geo, s.groundSpeedMs) : null;
        // ATC follows the flight too (its monitors and reply timers run on this clock)
        if (this.inFlight && !this.slew) this.plugins.atc?.update(ndt, s, this.weather.state);
      }
      this.composeControls(PHYSICS_DT, PHYSICS_DT);
      this.physicsStep(PHYSICS_DT);
      this.time.utcMs += PHYSICS_DT * 1000;
      this.time.simTimeS += PHYSICS_DT;
    }
    copyPose(this.fdm.state, this.prev);
  }

  /**
   * Save the 3D view as a PNG (F12). Called right after render() in the same task, so the drawing
   * buffer is still intact without preserveDrawingBuffer. DOM overlays (menus, HUD) are not included.
   */
  private saveScreenshot(): void {
    const canvas = this.gfx.renderer.domElement;
    if (typeof document === 'undefined' || !canvas.toBlob) return;
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const name = `flightsim-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.events.emit('ui:toast', { text: `Screenshot saved: ${name}`, kind: 'info', durationMs: 3000 });
    }, 'image/png');
  }

  private onCrash(reason: string): void {
    const key = this.input.getBindingLabel('resetFlight' as never) || 'the menu';
    this.events.emit('ui:toast', { text: `Crash: ${reason}. Press ${key} to restart.`, kind: 'error', durationMs: 8000 });
  }

  private readonly onResize = (): void => {
    const el = this.opts.container;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    this.gfx.resize(w, h);
    this.cameras.handleResize(w / h);
    this.plugins.hud?.resize(w, h, window.devicePixelRatio || 1);
  };

  resize(): void { this.onResize(); }

  /** Heading/altitude helpers for UIs. */
  get magVariationDeg(): number { return this.magVar; }
  static wrapHeading(d: number): number { return wrap360(d); }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.world.dispose();
    this.sky.dispose();
    this.model.dispose();
    this.steamTex.dispose();
    this.g1000Tex?.dispose();
    this.gfx.dispose();
  }
}

/** localStorage key counting the flights that opened with the controls tip, and how many get one */
const TIP_COUNT_KEY = 'flightsim.tips.v1';
const TIP_FLIGHTS = 3;

function safeLocalStorage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/**
 * How hard it rains on the windscreen (0…1): rain (snow wets it a little: flakes melt on the glass)
 * below the top of the rain-bearing (lowest dense) cloud layer; ~8 mm/h is heavy.
 */
export function windscreenRain(w: Pick<import('../core/types').WeatherState, 'precipitationRate' | 'precipitationType' | 'clouds'>, altMslM: number): number {
  if (!(w.precipitationRate > 0) || w.precipitationType === 'none') return 0;
  const layer = w.clouds.filter((c) => c.coverage >= 0.5 && c.type !== 'cirrus').sort((a, b) => a.baseM - b.baseM)[0];
  if (layer && altMslM > layer.topM) return 0;
  const k = Math.min(1, 0.25 + w.precipitationRate / 8);
  return w.precipitationType === 'snow' ? 0.35 * k : k;
}

/**
 * Thermal strength (0…1) and the convective top above the ground: driven by the sun's height (none
 * below 10°, full from 45°), damped by stratus cover, cold air and snow cover, none in precipitation;
 * the top is the cumulus base when there is one (thermals feed those clouds), else ~1500 m.
 */
export function convectionFor(w: Pick<import('../core/types').WeatherState, 'clouds' | 'precipitationRate' | 'temperatureC'>, sunElevationRad: number, groundMslM: number, snowCover = 0): { strength: number; topAglM: number } {
  const sm = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  if (w.precipitationRate > 0) return { strength: 0, topAglM: 1500 };
  const sun = sm(10, 45, (sunElevationRad * 180) / Math.PI);
  const stratus = w.clouds.filter((c) => c.type === 'stratus').reduce((m, c) => Math.max(m, c.coverage), 0);
  const warm = sm(-5, 18, w.temperatureC);
  const strength = sun * (1 - 0.9 * stratus) * (0.3 + 0.7 * warm) * (1 - 0.7 * snowCover);
  const cu = w.clouds.filter((c) => c.type === 'cumulus').sort((a, b) => a.baseM - b.baseM)[0];
  const top = cu ? cu.baseM - groundMslM : 1500;
  return { strength, topAglM: Math.max(400, Math.min(3000, top)) };
}
