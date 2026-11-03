/**
 * The simulator: owns every subsystem, the fixed-step physics loop and the render loop, and
 * assembles the SimSnapshot that instruments, audio and UI read each frame.
 */
import * as THREE from 'three';
import { EventBus } from '../core/events';
import { clamp, wrap360 } from '../core/math';
import { defaultControlInputs, type AircraftConfig, type AircraftState, type Airport, type AssistanceOptions, type ControlInputs, type InputSnapshot, type SimAction, type SimSnapshot, type SpawnState, type TimeState, type WeatherPresetId } from '../core/types';
import { DEG, FPM, FT, INHG, KT, RAD } from '../core/units';
import { Fdm } from '../fdm/fdm';
import { C172S } from '../fdm/aircraft/c172';
import { atmosphere, casFromTas } from '../fdm/atmosphere';
import { NavDb, FlightPlanner, fetchLoader, runwayInUse, type FlightPlanEx } from '../nav';
import { magneticDeclinationDeg } from '../geo/magvar';
import { sunEvents } from '../geo/solar';
import { LocalFrame, nedToThree } from '../geo/wgs84';
import { World } from '../world/World';
import { TerrainSystem } from '../terrain/TerrainSystem';
import { SkySystem, WeatherSystem } from '../sky';
import { AircraftModel, bodyQuatToThree } from '../aircraft3d';
import { CameraController } from '../camera';
import { InputManager } from '../input/InputManager';
import { GfcAutopilot } from '../autopilot/Autopilot';
import { SteamPanel } from '../instruments/SteamPanel';
import { TouchdownDetector } from '../activities/TouchdownDetector';
import { ReplayRecorder } from '../activities/ReplayRecorder';
import { LANDING_CHALLENGES } from '../activities/landingChallenges';
import { runwayEnds, type RunwayEndRef } from '../activities/runwayFrame';
import { FixedStepLoop, PHYSICS_DT } from './loop';
import { copyPose, interpolateState } from './interpolate';
import { RadioStack } from './radios';
import { createRenderer, type RendererBundle } from './renderer';

export interface SimulatorOptions {
  container: HTMLElement;
  /** base URL for /data (Vite BASE_URL) */
  baseUrl: string;
  quality?: 'low' | 'medium' | 'high' | 'ultra';
  /** stream real terrain (default true) */
  terrain?: boolean;
  imagery?: 'satellite' | 'procedural';
}

/** Optional subsystems attached after construction (UI, glass cockpit, HUD, audio, ATC). */
export interface SimPlugins {
  ui?: { update(s: SimSnapshot, dt: number): void; handleAction?(a: SimAction): boolean };
  g1000?: { update(s: SimSnapshot, dt: number): boolean; readonly pfdCanvas: HTMLCanvasElement | OffscreenCanvas };
  hud?: { update(s: SimSnapshot, dt: number): void; resize(w: number, h: number, dpr: number): void; readonly canvas: HTMLCanvasElement | OffscreenCanvas };
  audio?: { update(dt: number, ac: AircraftState, cam: SimSnapshot['camera'], w: SimSnapshot['weather']): void; onTouchdown?(vsMs: number): void; setMarker?(m: string | null): void };
  atc?: { update(dt: number, ac: AircraftState, w: SimSnapshot['weather']): void; select(i: number): void; reset(a: Airport | null): void };
}

export const DEFAULT_ASSISTS: AssistanceOptions = {
  autoRudder: false, assistedTakeoff: false, assistedLanding: false, autoMixture: true, unlimitedFuel: false,
  crashDamage: true, stressDamage: false, gyroDrift: false, landingPathHints: true, taxiRibbon: false, routeRibbon: true,
};

const SPAWN_ROLL_OFFSET_M = 40;

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

  readonly config: AircraftConfig = C172S;
  readonly nav: NavDb;
  readonly fdm: Fdm;
  readonly weather: WeatherSystem;
  readonly world: World;
  readonly terrain: TerrainSystem | null;
  readonly scene = new THREE.Scene();
  readonly gfx: RendererBundle;
  readonly sky: SkySystem;
  readonly model: AircraftModel;
  readonly cameras: CameraController;
  readonly input: InputManager;
  readonly autopilot: GfcAutopilot;
  readonly radios: RadioStack;
  readonly planner = new FlightPlanner();
  readonly touchdown: TouchdownDetector;
  readonly replay = new ReplayRecorder(300, 30);
  readonly steam: SteamPanel;
  readonly plugins: SimPlugins = {};
  /** effective controls after assists and autopilot, fed to the flight model */
  readonly effective: ControlInputs = defaultControlInputs();
  /** automation overrides applied after the input layer (tests, smoke test, scripted demos) */
  readonly overrides: Partial<ControlInputs> = {};
  lastSpawn: { airport: Airport | null; spawn: SpawnState; end: RunwayEndRef | null } | null = null;
  currentAirport: Airport | null = null;
  panelVariant: 'steam' | 'g1000' = 'steam';
  weatherPreset: WeatherPresetId = 'few';

  private readonly loop = new FixedStepLoop(PHYSICS_DT);
  private readonly prev: AircraftState;
  private readonly interp: AircraftState;
  private plan: FlightPlanEx | null = null;
  private readonly steamTex: THREE.CanvasTexture;
  private g1000Tex: THREE.CanvasTexture | null = null;
  private lastMs = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private autoStartT = -1;
  private nearbyAirports: Airport[] = [];
  private nearbyTimer = Infinity;
  private magVar = 0;
  private magTimer = Infinity;
  private raf = 0;
  private readonly posThree = new THREE.Vector3();
  private readonly qThree = new THREE.Quaternion();
  private readonly v3: [number, number, number] = [0, 0, 0];
  private readonly tmpV = new THREE.Vector3();
  private readonly ambient = new THREE.Color();
  readonly snapshot: SimSnapshot;

  constructor(readonly opts: SimulatorOptions) {
    this.gfx = createRenderer(opts.container, opts.quality ?? 'high');
    this.nav = new NavDb(fetchLoader(opts.baseUrl));
    this.fdm = new Fdm(this.config, { seed: 1 });
    this.fdm.setFuelFraction(1);
    this.weather = new WeatherSystem({});
    this.weather.setPreset(this.weatherPreset, 0);
    const home = new LocalFrame(37.613538, -122.35716, 0);
    this.terrain = opts.terrain === false ? null : new TerrainSystem(home, { depthMode: this.gfx.depthMode, maxAnisotropy: this.gfx.maxAnisotropy, imagery: opts.imagery ?? 'satellite' });
    this.world = new World(this.terrain, this.nav, this.weather, home.lat0, home.lon0);
    this.scene.add(this.world.group);
    this.sky = new SkySystem(this.scene, this.gfx.renderer, { shadows: this.gfx.renderer.shadowMap.enabled });
    this.model = new AircraftModel(this.config);
    this.scene.add(this.model.root);
    const aspect = (opts.container.clientWidth || 1) / (opts.container.clientHeight || 1);
    this.cameras = new CameraController(aspect);
    this.input = new InputManager(this.gfx.renderer.domElement, { flapDetents: this.config.controls.flaps.detentsDeg.length });
    this.autopilot = new GfcAutopilot({ events: this.events });
    this.radios = new RadioStack(this.nav);
    this.touchdown = new TouchdownDetector(this.events, { airports: () => this.nearbyAirports });
    this.steam = new SteamPanel({});
    this.steamTex = new THREE.CanvasTexture(this.steam.canvas as HTMLCanvasElement);
    this.steamTex.colorSpace = THREE.SRGBColorSpace;
    this.steamTex.anisotropy = Math.min(8, this.gfx.maxAnisotropy);
    this.model.panelMesh.material.map = this.steamTex;
    this.model.panelMesh.material.needsUpdate = true;
    this.prev = structuredClone(this.fdm.state);
    this.interp = structuredClone(this.fdm.state);
    this.snapshot = this.buildSnapshot();
    this.events.on('aircraft:touchdown', (e) => this.plugins.audio?.onTouchdown?.(e.verticalSpeedMs));
    this.events.on('aircraft:crash', (e) => this.onCrash(e.reason));
    window.addEventListener('resize', this.onResize);
  }

  /** Attach a glass cockpit: its PFD canvas replaces the steam panel texture. */
  attachG1000(g: NonNullable<SimPlugins['g1000']>): void {
    this.plugins.g1000 = g;
    this.g1000Tex = new THREE.CanvasTexture(g.pfdCanvas as HTMLCanvasElement);
    this.g1000Tex.colorSpace = THREE.SRGBColorSpace;
  }

  /** Swap the cockpit panel between steam gauges and the G1000 (falls back to steam if no G1000 is attached). */
  setPanel(variant: 'steam' | 'g1000'): void {
    this.panelVariant = variant === 'g1000' && this.g1000Tex ? 'g1000' : 'steam';
    if (variant === 'g1000' && this.g1000Tex) {
      this.model.setPanelVariant('g1000');
      const mesh = (this.model as unknown as { cockpit: { panelMeshG1000: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> } }).cockpit.panelMeshG1000;
      mesh.material.map = this.g1000Tex;
      mesh.material.needsUpdate = true;
    } else this.model.setPanelVariant('steam');
  }

  start(): void {
    this.lastMs = performance.now();
    const tick = (now: number) => { this.raf = requestAnimationFrame(tick); this.frame(now); };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void { cancelAnimationFrame(this.raf); }

  // ─────────────────────────────── frame loop ───────────────────────────────

  /** One display frame: input → physics (fixed steps) → world/sky/camera → instruments → render. */
  frame(nowMs: number): void {
    const dt = clamp((nowMs - this.lastMs) / 1000, 0, 0.25);
    this.lastMs = nowMs;
    this.frameCount++;
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) { this.fps = this.fpsFrames / this.fpsAcc; this.fpsAcc = 0; this.fpsFrames = 0; }

    const t0 = performance.now();
    const inp = this.input.poll(dt);
    for (let i = 0; i < inp.actions.length; i++) this.handleAction(inp.actions[i]);
    this.composeControls(dt);
    const t1 = performance.now();

    const running = this.inFlight && !this.paused;
    const scale = running ? this.time.timeScale : 0;
    let alpha = 1;
    if (running) {
      const r = this.loop.advance(dt, Math.min(scale, 8), () => copyPose(this.fdm.state, this.prev), (h) => this.physicsStep(h));
      alpha = r.alpha;
      this.time.utcMs += r.simDt * 1000;
      this.time.simTimeS += r.simDt;
      if (scale > 8) this.time.utcMs += dt * (scale - 8) * 1000; // time compression beyond physics speed moves only the clock
    }
    interpolateState(this.prev, this.fdm.state, running ? alpha : 1, this.interp);
    const t2 = performance.now();
    this.mark('input', t1 - t0);
    this.mark('physics', t2 - t1);
    this.updateVisuals(dt, inp);
  }

  private mark(k: keyof Simulator['timings'], ms: number): void { this.timings[k] += (ms - this.timings[k]) * 0.1; }

  /** Pilot controls → assists → autopilot → effective controls (allocation-free). */
  private composeControls(dt: number): void {
    const u = this.input.controls;
    Object.assign(this.effective, u);
    this.effective.lights = u.lights;
    for (const k in this.overrides) (this.effective as unknown as Record<string, unknown>)[k] = (this.overrides as Record<string, unknown>)[k];
    const s = this.fdm.state;
    if (this.assists.autoMixture && this.effective.mixture > 0.05 && s.engine.running) this.effective.mixture = Math.min(this.effective.mixture, this.fdm.bestPowerMixture());
    if (this.assists.autoRudder && !s.onGround) this.effective.yaw = clamp(this.effective.yaw + 6 * s.aero.beta, -1, 1);
    // engine auto-start sequence (Ctrl+E)
    if (this.autoStartT >= 0) {
      this.autoStartT += dt;
      this.effective.mixture = 1; this.effective.magnetos = 3; this.effective.fuelSelector = 'both';
      this.effective.throttle = Math.max(this.effective.throttle, 0.12);
      this.effective.starter = this.autoStartT > 0.6 && !s.engine.running;
      if (s.engine.running && this.autoStartT > 1.5) {
        this.autoStartT = -1;
        this.input.controls.mixture = 1; this.input.controls.magnetos = 3; this.input.controls.fuelSelector = 'both';
        this.events.emit('engine:started', {});
      } else if (this.autoStartT > 12) this.autoStartT = -1;
    }
    this.autopilot.update(dt, s, { nav1: this.radios.nav1, nav2: this.radios.nav2, plan: this.plan });
    const ap = this.autopilot.apply(this.effective);
    if (ap !== this.effective) Object.assign(this.effective, ap);
  }

  private physicsStep(h: number): void {
    const s = this.fdm.state;
    const env = this.world.env;
    env.surface = this.world.surfaceAt(s.posNED[0], s.posNED[1]);
    const w = this.weather.state;
    env.qnhPa = w.qnhPa;
    env.deltaTisaK = w.temperatureC - 15;
    env.turbulence.intensity = w.turbulence;
    env.turbulence.w20Kt = 0;
    if (this.assists.unlimitedFuel && s.fuelKg.some((f, i) => f < this.config.mass.tanks[i].capacityKg - 1)) this.fdm.setFuelFraction(1);
    this.fdm.step(h, this.effective, env);
    this.touchdown.step(h, s);
    this.replay.record(h, s, this.effective);
    const t = this.world.maybeRebase(s.posNED);
    if (t) {
      this.fdm.rebase(t.rotation, t.translationNED);
      const shift = nedToThree(t.translationNED, this.v3);
      this.tmpV.set(shift[0], shift[1], shift[2]);
      this.sky.notifyRebase(this.tmpV);
      this.weather.notifyRebase(shift[0], shift[2]);
      this.cameras.shiftOrigin(this.tmpV.clone().negate());
      this.replay.clear();
      copyPose(this.fdm.state, this.prev);
      this.events.emit('frame:rebased', { frame: this.world.frame.info });
    }
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
    this.cameras.update(dt, s, this.posThree, this.qThree, inp, this.model.eyePointLocal);
    const camPos = this.cameras.positionThree();
    let tm = performance.now();

    // weather, sky and world
    this.weather.update(dt * (this.paused ? 0 : this.time.timeScale), { tasMs: s.aero.tas, altMslM: s.altitudeMslM, aglM: s.altitudeAglM });
    this.sky.update({ time: this.time, aircraft: s, weather: this.weather.state, frame: this.world.frame.info }, camPos, dt);
    this.model.setSunElevation(this.sky.sun.elevationRad);
    const L = this.sky.lighting;
    this.ambient.copy(L.skyColorZenith).multiplyScalar(L.ambientIntensity);
    this.terrain?.setSun(L.sunDirThree, L.sunColor, L.sunIntensity, this.ambient);
    this.terrain?.setFog(L.fogColor, L.fogDensity, L.fogHeightFalloff);
    let tn = performance.now(); this.mark('sky', tn - tm); tm = tn;
    this.world.update(dt, camPos, this.cameras.camera, s.geo, this.v3, this.sky.sun.elevationRad);
    tn = performance.now(); this.mark('world', tn - tm); tm = tn;

    // navigation (radios every frame, nearby airports and magnetic variation slowly)
    this.nearbyTimer += dt;
    if (this.nearbyTimer > 2) { this.nearbyTimer = 0; this.nearbyAirports = this.nav.nearestAirports(s.geo, 12, 40); }
    this.magTimer += dt;
    if (this.magTimer > 30) { this.magTimer = 0; this.magVar = magneticDeclinationDeg(s.geo.lat, s.geo.lon, s.geo.alt, this.time.utcMs); }
    this.radios.update(dt, s.geo, this.magVar);
    this.plan = this.planner.waypoints.length ? this.planner.update(s.geo, s.groundSpeedMs) : null;

    const snap = this.refreshSnapshot();
    if (this.steam.update(snap, dt)) this.steamTex.needsUpdate = true;
    if (this.plugins.g1000 && this.plugins.g1000.update(snap, dt) && this.g1000Tex) this.g1000Tex.needsUpdate = true;
    this.plugins.hud?.update(snap, dt);
    this.plugins.audio?.update(dt, s, this.cameras.state, this.weather.state);
    if (this.inFlight) this.plugins.atc?.update(dt * (this.paused ? 0 : 1), s, this.weather.state);
    this.plugins.ui?.update(snap, dt);
    if ((this.frameCount & 15) === 0) this.events.emit('terrain:progress', { ready: snap.terrainReady });
    tn = performance.now(); this.mark('instruments', tn - tm); tm = tn;
    this.gfx.renderer.render(this.scene, this.cameras.camera);
    this.mark('render', performance.now() - tm);
  }

  // ─────────────────────────────── actions ───────────────────────────────

  /** Simulator-level handling of discrete actions (keyboard, gamepad, UI buttons). */
  handleAction(a: SimAction): void {
    if (this.radios.handleAction(a)) return;
    if (this.plugins.ui?.handleAction?.(a)) return;
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
      case 'repairRefuel': this.fdm.clearCrash(); this.fdm.setFuelFraction(1); break;
      case 'engineAutoStart': if (!s.engine.running) this.autoStartT = 0; break;
      case 'engineShutdown': this.input.controls.mixture = 0; this.input.controls.magnetos = 0; this.events.emit('engine:stopped', { reason: 'shutdown' }); break;
      case 'altimeterInc': this.fdm.setAltimeter(s.qnhSetPa + 0.01 * INHG); break;
      case 'altimeterDec': this.fdm.setAltimeter(s.qnhSetPa - 0.01 * INHG); break;
      // B (MSFS): set the altimeter to the local QNH; pressing it again when already set selects standard
      case 'altimeterStd': this.fdm.setAltimeter(Math.abs(s.qnhSetPa - this.weather.state.qnhPa) < 30 ? 101325 : this.weather.state.qnhPa); break;
      case 'apToggle': ap.engage(!aps.engaged); break;
      case 'fdToggle': aps.flightDirector = !aps.flightDirector; break;
      case 'yawDamper': aps.yawDamper = !aps.yawDamper; break;
      case 'apHdg': ap.setLateral(aps.lateral === 'HDG' ? 'ROL' : 'HDG'); this.ensureAp(); break;
      case 'apNav': ap.setLateral(aps.lateral === 'NAV' ? 'ROL' : 'NAV'); this.ensureAp(); break;
      case 'apApr': ap.setLateral(aps.lateral === 'APR' ? 'ROL' : 'APR'); this.ensureAp(); break;
      case 'apAlt': ap.setAltitudeTarget(Math.round(s.altitudeIndicatedM / FT / 100) * 100 * FT); ap.setVertical('ALT'); this.ensureAp(); break;
      case 'apVs': ap.setVerticalSpeedTarget(Math.round(s.verticalSpeedMs / FPM / 100) * 100 * FPM); ap.setVertical('VS'); this.ensureAp(); break;
      case 'apFlc': ap.setIasTarget(Math.round(s.aero.ias / KT) * KT); ap.setVertical('FLC'); this.ensureAp(); break;
      case 'apLvl': ap.setLateral('ROL'); ap.setVerticalSpeedTarget(0); ap.setVertical('VS'); this.ensureAp(); break;
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
      case 'slewToggle': this.slew = !this.slew; break;
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
    await this.beginFlight(airport, end, { geo: { lat: pos.lat, lon: pos.lon, alt: elev }, headingRad: hdg * DEG, speedMs: 0, onGround: true, engineRunning: !opts.coldAndDark }, opts);
  }

  /** Spawn established on final for a landing challenge. */
  async startChallenge(id: string): Promise<void> {
    const c = LANDING_CHALLENGES.find((x) => x.id === id);
    if (!c) throw new Error(`unknown challenge ${id}`);
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
    this.setLocalHour(c.localHour);
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

  /** Common spawn path: new origin, terrain prefetch, airport geometry, flight-model reset, systems reset. */
  private async beginFlight(airport: Airport | null, end: RunwayEndRef | null, spawn: SpawnState, opts: { fuelFraction?: number; payloadKg?: number; flapsIndex?: number }): Promise<void> {
    this.inFlight = false;
    this.paused = true;
    const g = spawn.geo;
    if (airport) await this.nav.loadRegion(airport.position, 40);
    this.currentAirport = airport;
    this.world.setOrigin(g.lat, g.lon, spawn.onGround ? g.alt : airport?.elevationM ?? 0);
    if (airport) { this.world.airports.ensureAirport(airport); this.world.syncRunways(); }
    this.weather.setAirportElevation(airport?.elevationM ?? 0);
    this.weather.setFrame(this.world.frame.info);
    this.nearbyAirports = this.nav.nearestAirports(g, 12, 40);
    // wait for the ground under the spawn (or give up after a few seconds and use the runway elevation)
    if (this.terrain) await Promise.race([this.terrain.prefetch(g.lat, g.lon, 2500), new Promise((r) => setTimeout(r, 8000))]);
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
    c.flapsIndex = opts.flapsIndex ?? 0;
    c.lights = { nav: true, beacon: spawn.engineRunning, strobe: !spawn.onGround, landing: !spawn.onGround, taxi: spawn.onGround && spawn.engineRunning, panel: 0 };
    this.fdm.clearCrash();
    this.fdm.reset(spawn, this.world.env);
    if (!spawn.onGround) {
      // trim with the approach flaps set
      const u = { ...c };
      this.fdm.step(PHYSICS_DT, u, this.world.env);
      const cas = casFromTas(spawn.speedMs, this.fdm.state.atmosphere.pressurePa, this.fdm.state.atmosphere.speedOfSound);
      this.fdm.trim(cas, spawn.gammaRad ?? 0, this.world.env);
      const tr = this.fdm.trimResult;
      if (tr) { c.throttle = tr.throttle; c.pitchTrim = tr.pitchTrim; }
    }
    this.fdm.setAltimeter(this.weather.state.qnhPa);
    copyPose(this.fdm.state, this.prev);
    this.loop.reset();
    this.autopilot.engage(false);
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
    this.paused = false;
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
    return sn;
  }

  /** Latest physics state (not interpolated). */
  get aircraft(): AircraftState { return this.fdm.state; }

  /** Run the physics as fast as possible for `seconds` of sim time (automation/tests); no rendering. */
  advance(seconds: number): void {
    const n = Math.round(seconds / PHYSICS_DT);
    for (let i = 0; i < n && !this.fdm.state.crashed; i++) {
      this.composeControls(PHYSICS_DT);
      this.physicsStep(PHYSICS_DT);
      this.time.utcMs += PHYSICS_DT * 1000;
      this.time.simTimeS += PHYSICS_DT;
    }
    copyPose(this.fdm.state, this.prev);
  }

  private onCrash(reason: string): void {
    this.events.emit('ui:toast', { text: `Crash: ${reason}. Press Ctrl+R to restart.`, kind: 'error', durationMs: 8000 });
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
