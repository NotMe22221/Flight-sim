/**
 * The simulator side of the UI contract (src/ui/UiHost.ts). The UI never touches simulator
 * internals; everything goes through these methods.
 */
import type { AircraftConfig, AssistanceOptions, CameraMode, SimAction, SimSnapshot, Waypoint, WeatherPresetId, WeatherState } from '../core/types';
import { C172S } from '../fdm/aircraft/c172';
import { AIRCRAFT, C172S_G1000 } from './aircraftCatalog';
import { fetchOpenMeteo, OPEN_METEO_ATTRIBUTION, weatherFromPreset } from '../sky';
import type { AudioSettings, BindingInfo, GraphicsSettings, SpawnChoice, UiHost, UnitsSettings } from '../ui/UiHost';
import type { Simulator } from './Simulator';

const CREDITS = [
  'Terrain: Mapzen/Tilezen Terrain Tiles on AWS Open Data — 3DEP, GMTED2010 and SRTM courtesy of the U.S. Geological Survey; ETOPO1 © NOAA; EU-DEM produced using Copernicus data; © offene Daten Österreichs – DGM; © Kartverket; LINZ; Geoscience Australia; INEGI; ArcticDEM (NSF).',
  'Imagery: Sentinel-2 cloudless — https://s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016 & 2017), CC BY 4.0; NASA GIBS, EOSDIS.',
  'Airports, runways, navaids and frequencies: OurAirports (public domain). ILS data is synthesized.',
  'Magnetic variation: World Magnetic Model 2025, NOAA NCEI and BGS (public domain).',
  OPEN_METEO_ATTRIBUTION,
  'Flight model reference data: JSBSim and FlightGear c172p (reference numbers only), NACA Report 640, MIL-F-8785C, Cessna 172S POH figures.',
  'Built with Three.js (MIT).',
];

export class SimUiHost implements UiHost {
  private units: UnitsSettings = { altitude: 'ft', speed: 'kt', pressure: 'inHg', distance: 'nm', temperature: 'C' };
  private audioSettings: AudioSettings = { master: 0.8, engine: 1, environment: 0.8, cockpit: 0.8, ui: 0.6, atc: 0.9 };
  onAudioSettings: ((a: AudioSettings) => void) | null = null;

  constructor(private readonly sim: Simulator) {}

  get events() { return this.sim.events; }
  get nav() { return this.sim.nav; }
  snapshot(): SimSnapshot { return this.sim.snapshot; }
  aircraftList(): AircraftConfig[] { return [...AIRCRAFT]; }
  currentAircraft(): AircraftConfig { return this.sim.panelVariant === 'g1000' ? C172S_G1000 : C172S; }

  dispatch(action: SimAction): void {
    // Same path as a key press: the input layer applies control actions (flaps, gear, lights …)
    // immediately and reports the action in the next snapshot, where the simulator handles the rest
    // exactly once.
    this.sim.input.applyAction(action as never);
  }

  async spawn(choice: SpawnChoice, aircraftId: string, options: { fuelFraction: number; payloadKg: number }): Promise<void> {
    this.sim.setPanel(aircraftId === C172S_G1000.id ? 'g1000' : 'steam');
    await this.sim.spawnAtRunway(choice.airport, choice.runwayEnd?.endIdent ?? null, { coldAndDark: choice.coldAndDark || !choice.runwayEnd, fuelFraction: options.fuelFraction, payloadKg: options.payloadKg });
  }

  startChallenge(id: string): Promise<void> { return this.sim.startChallenge(id); }

  /** In flight the weather blends over 30 s; `immediate` (a new flight starting) applies it at once. */
  setWeatherPreset(id: WeatherPresetId, opts?: { immediate?: boolean }): void { this.sim.setWeatherPreset(id, this.sim.inFlight && !opts?.immediate ? 30 : 0); }
  setCustomWeather(w: WeatherState, opts?: { immediate?: boolean }): void {
    this.sim.weather.setState(w, this.sim.inFlight && !opts?.immediate ? 30 : 0);
    this.sim.events.emit('weather:changed', { state: this.sim.weather.state });
  }

  /** COM1 frequencies for the ATC panel header. */
  comRadio(): { activeMHz: number; standbyMHz: number } | null {
    const c = this.sim.radios.state.com1;
    return c ? { activeMHz: c.activeMHz, standbyMHz: c.standbyMHz } : null;
  }

  /** Settings > General > Flight info strip: the HUD's flight-data tapes in external views. */
  infoStrip = true;
  setInfoStrip(visible: boolean): void { this.infoStrip = visible; }

  async requestLiveWeather(): Promise<boolean> {
    const g = this.sim.aircraft.geo;
    try {
      const ws = await fetchOpenMeteo(g.lat || 37.62, g.lon || -122.37, {});
      if (!ws) return false;
      this.sim.weather.applyLive(ws, 30);
      this.sim.events.emit('weather:changed', { state: this.sim.weather.state });
      return true;
    } catch {
      return false;
    }
  }

  setTime(utcMs: number): void { this.sim.time.utcMs = utcMs; this.sim.sky.resetAdaptation(); this.sim.events.emit('time:changed', { state: this.sim.time }); }
  setTimeScale(scale: number): void { this.sim.time.timeScale = Math.max(0.25, Math.min(16, scale)); this.sim.events.emit('time:changed', { state: this.sim.time }); }
  setPaused(paused: boolean): void { this.sim.setPaused(paused); }
  setCamera(mode: CameraMode): void { this.sim.cameras.setMode(mode); this.sim.events.emit('camera:changed', { mode }); }
  setAssists(a: AssistanceOptions): void { this.sim.assists = { ...a }; }

  setGraphics(g: GraphicsSettings): void {
    this.sim.gfx.setQuality(g.quality, g.renderScale);
    this.sim.cameras.setFov(g.fov);
    this.sim.terrain?.setImagery(g.imagery);
    this.sim.sky.clouds.group.visible = g.clouds;
    this.sim.setShadows(g.shadows);
  }

  setAudio(a: AudioSettings): void { this.audioSettings = { ...a }; this.onAudioSettings?.(this.audioSettings); }
  setUnits(u: UnitsSettings): void { this.units = { ...u }; }
  get currentUnits(): UnitsSettings { return this.units; }

  bindings(): BindingInfo[] {
    return this.sim.input.bindingsList().map((r) => ({ action: r.action, label: r.label, device: r.device, group: r.group }));
  }

  async rebind(action: SimAction): Promise<BindingInfo | null> {
    const r = await this.sim.input.startListening(action as never);
    return r ? { action, label: r.label, device: r.device, group: r.group } : null;
  }

  resetBindings(profile: 'default' | 'msfs' | 'laptop' | 'gamepad-xbox' | 'joystick-generic'): void { this.sim.input.resetProfile(profile); }

  dataCredits(): string[] {
    // the terrain system reports its own (provider-specific) lines: use them instead of the generic one
    const terrain = this.sim.terrain?.attribution() ?? [];
    const base = terrain.length ? CREDITS.filter((c) => !c.startsWith('Terrain:')) : CREDITS;
    return [...base, ...terrain];
  }

  captureInput(captured: boolean): void { this.sim.input.setCaptured(captured); }

  addWaypoint(wp: Waypoint): void { this.sim.planner.add(wp); }
  clearPlan(): void { this.sim.planner.clear(); }

  /** Weather preset preview used by the World Map before a flight exists. */
  static presetPreview(id: WeatherPresetId, elevationM: number): WeatherState { return weatherFromPreset(id, elevationM); }
}
