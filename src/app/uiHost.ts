/**
 * The simulator side of the UI contract (src/ui/UiHost.ts). The UI never touches simulator
 * internals; everything goes through these methods.
 */
import type { AircraftConfig, AssistanceOptions, FailureId, CameraMode, SimAction, SimSnapshot, Waypoint, WeatherPresetId, WeatherState } from '../core/types';
import { AIRCRAFT, aircraftById, aircraftForActivity } from './aircraftCatalog';
import { fetchOpenMeteo, OPEN_METEO_ATTRIBUTION, weatherFromPreset } from '../sky';
import type { AudioSettings, BindingInfo, CareerJobView, CareerView, GraphicsSettings, LogbookView, MassState, SpawnChoice, UiHost, UnitsSettings } from '../ui/UiHost';
import { CAREER_HOME, type Licence } from '../activities/career/careerStore';
import { LICENCES, examActivity, missingFor } from '../activities/career/licences';
import { C172_FIELDS, CUB_FIELDS, JOB_LABEL, generateJobs, jobActivity, type CareerJob } from '../activities/career/missions';
import { computeMassProperties } from '../fdm/massProps';
import { AVGAS_KG_PER_GAL } from '../core/units';
import type { Simulator } from './Simulator';
import { QUALITY } from './renderer';
import { SAVED_FLIGHT_KEY, readSavedFlight, savedFlightLabel } from './savedFlight';
import { magneticDeclinationDeg } from '../geo/magvar';
import { discoveryById } from '../activities/discovery';
import { bushLegActivity, lessonById, tripById, type ActivityRunner, type ProgressStore } from '../activities';

const CREDITS = [
  'Terrain: Mapzen/Tilezen Terrain Tiles on AWS Open Data — 3DEP, GMTED2010 and SRTM courtesy of the U.S. Geological Survey; ETOPO1 © NOAA; EU-DEM produced using Copernicus data; © offene Daten Österreichs – DGM; © Kartverket; LINZ; Geoscience Australia; INEGI; ArcticDEM (NSF).',
  'Imagery: Sentinel-2 cloudless — https://s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016 & 2017), CC BY 4.0; NASA GIBS, EOSDIS.',
  'Airports, runways, navaids and frequencies: OurAirports (public domain). ILS data is synthesized.',
  'Magnetic variation: World Magnetic Model 2025, NOAA NCEI and BGS (public domain).',
  OPEN_METEO_ATTRIBUTION,
  'Flight model reference data: JSBSim and FlightGear c172p and J3Cub (reference numbers only), NACA Report 640, NACA TR 315, USAF DATCOM methods, MIL-F-8785C, Cessna 172S POH and Piper PA-18-150 owner\'s handbook / TCDS 1A2 figures.',
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
  /** the aircraft being flown (its catalog entry: 172S, 172S G1000 or the Super Cub) */
  currentAircraft(): AircraftConfig { return this.sim.config; }

  dispatch(action: SimAction): void {
    // Same path as a key press: the input layer applies control actions (flaps, gear, lights …)
    // immediately and reports the action in the next snapshot, where the simulator handles the rest
    // exactly once.
    this.sim.input.applyAction(action as never);
  }

  async spawn(choice: SpawnChoice, aircraftId: string, options: { fuelFraction: number; payloadKg: number }): Promise<void> {
    // a new airframe rebuilds the flight model, 3D model and panel before the spawn (unknown ids keep the current one)
    this.sim.selectAircraft(aircraftId);
    if (!choice.runwayEnd) await this.sim.spawnAtParking(choice.airport, { fuelFraction: options.fuelFraction, payloadKg: options.payloadKg });
    else await this.sim.spawnAtRunway(choice.airport, choice.runwayEnd.endIdent, { coldAndDark: choice.coldAndDark, fuelFraction: options.fuelFraction, payloadKg: options.payloadKg });
  }

  startChallenge(id: string): Promise<void> { return this.sim.startChallenge(id); }

  // ── activities (src/activities): lessons and bush-trip legs ──
  /** Start a lesson by id (LESSONS in src/activities). */
  async startLesson(id: string): Promise<void> {
    const def = lessonById(id);
    if (!def) throw new Error(`unknown lesson ${id}`);
    await this.sim.activities.start(def);
  }
  /** Start leg `legIndex` of a bush trip (BUSH_TRIPS); fuel carries over from the previous leg when recorded. */
  async startBushLeg(tripId: string, legIndex: number): Promise<void> {
    const trip = tripById(tripId);
    if (!trip) throw new Error(`unknown bush trip ${tripId}`);
    const prevFuel = legIndex > 0 ? this.sim.activityProgress.leg(trip.id, legIndex - 1)?.fuelKg : undefined;
    // the trip's own aircraft (the Pacific Coast trip flies the Super Cub): fuel as a fraction of its tanks
    const usable = aircraftForActivity(trip.aircraft, this.sim.config).mass.tanks.reduce((a, t) => a + t.usableKg, 0);
    const fuelFraction = prevFuel != null && usable > 0 ? Math.min(1, Math.max(0.1, prevFuel / usable)) : undefined;
    await this.sim.activities.start(bushLegActivity(trip, legIndex, fuelFraction !== undefined ? { fuelFraction } : {}));
  }
  // ── career ──
  private careerBoard: { key: string; jobs: CareerJob[] } | null = null;

  career(): CareerView {
    const c = this.sim.career.state;
    const hours = this.sim.logbook.totals().airTimeS / 3600;
    const facts = { licences: c.licences, logbookHours: hours, jobsDone: c.jobsDone, reputation: c.reputation };
    const ap = this.sim.nav.getAirport(c.location);
    return {
      money: c.money, reputation: c.reputation, jobsDone: c.jobsDone, logbookHours: hours,
      location: { icao: c.location, name: ap?.name ?? c.location },
      ladder: LICENCES.map((l) => ({ id: l.id, title: l.title, unlocks: l.unlocks, needs: l.needs, held: c.licences.includes(l.id), missing: missingFor(l.id, facts), exam: l.exam })),
      history: c.history.slice(-8).reverse().map((h) => ({ type: JOB_LABEL[h.type as keyof typeof JOB_LABEL] ?? h.type, from: h.from, to: h.to, pay: h.pay, success: h.success })),
    };
  }

  /** Commercial is granted (no check-ride) once its requirements are met. */
  private grantEarnedLicences(): void {
    const c = this.sim.career.state;
    const facts = { licences: c.licences, logbookHours: this.sim.logbook.totals().airTimeS / 3600, jobsDone: c.jobsDone, reputation: c.reputation };
    if (!c.licences.includes('commercial') && missingFor('commercial', facts).length === 0) this.sim.career.grantLicence('commercial');
  }

  async careerJobs(): Promise<CareerJobView[]> {
    this.grantEarnedLicences();
    const c = this.sim.career.state;
    await this.sim.nav.load();
    const origin = this.sim.nav.getAirport(c.location) ?? this.sim.nav.getAirport(CAREER_HOME);
    if (!origin) return [];
    const needs = this.sim.config.airframe === 'cub' ? CUB_FIELDS : C172_FIELDS;
    const key = `${origin.icao}|${c.seed}|${c.licences.join(',')}|${this.sim.config.airframe ?? 'c172'}`;
    if (this.careerBoard?.key !== key) {
      await this.sim.nav.loadRegion(origin.position, 90);
      const nearby = this.sim.nav.nearestAirports(origin.position, 60, 90);
      this.careerBoard = { key, jobs: generateJobs({ origin, nearby, licences: c.licences, needs, seed: c.seed, count: 6 }) };
    }
    return this.careerBoard.jobs.map((j) => ({
      id: j.id, type: j.type, typeLabel: JOB_LABEL[j.type], title: j.title, brief: j.brief, from: j.from, to: j.endsAt,
      distanceNm: j.distanceNm, payloadKg: j.payloadKg, pay: j.pay, licence: j.licence, timeLimitMin: j.timeLimitMin,
      locked: c.licences.includes(j.licence) ? null : `Needs ${LICENCES.find((l) => l.id === j.licence)?.title ?? j.licence}`,
    }));
  }

  async startCareerJob(id: string): Promise<void> {
    const job = this.careerBoard?.jobs.find((j) => j.id === id);
    if (!job) throw new Error('That job is no longer on the board');
    if (!this.sim.career.has(job.licence)) throw new Error('You do not hold the licence for this job yet');
    this.sim.career.begin(job);
    await this.sim.activities.start(jobActivity(job));
  }

  async startCareerExam(licence: string): Promise<void> {
    const def = examActivity(licence as Licence);
    if (!def) throw new Error('This licence has no check-ride');
    this.sim.career.beginExam(licence as Licence);
    await this.sim.activities.start(def);
  }

  resetCareer(): void { this.sim.career.reset(); this.careerBoard = null; }

  /** Discovery flight: its aircraft, weather and light, in the air near the landmark. */
  async startDiscovery(id: string): Promise<void> {
    const d = discoveryById(id);
    if (!d) throw new Error(`unknown discovery flight ${id}`);
    this.sim.selectAircraft(aircraftForActivity(d.aircraft, this.sim.config).id);
    this.sim.setWeatherPreset(d.weather, 0);
    this.sim.events.emit('weather:changed', { state: this.sim.weather.state });
    await this.sim.spawnInAir(d.lat, d.lon, d.altFt * 0.3048, d.headingDeg, d.iasKt * 0.514444);
    // the light of the place (after the spawn: the preset is solved for the new position)
    this.sim.setTimePreset(d.time);
  }
  // ── failures panel
  setFailure(id: FailureId, failed: boolean): void { this.sim.setFailure(id, failed); }

  logbook(): LogbookView { return { entries: this.sim.logbook.entries(), totals: this.sim.logbook.totals() }; }
  clearLogbook(): void { this.sim.logbook.clear(); }

  /** One saved-flight slot in localStorage (a few kB of JSON). */
  saveFlight(): boolean {
    const save = this.sim.saveFlight();
    if (!save) return false;
    try { localStorage.setItem(SAVED_FLIGHT_KEY, JSON.stringify(save)); return true; } catch { return false; }
  }
  savedFlightInfo(): { label: string; savedAtMs: number } | null {
    const s = readSavedFlight();
    return s ? { label: savedFlightLabel(s, aircraftById(s.aircraftId)?.name ?? s.aircraftId), savedAtMs: s.savedAtMs } : null;
  }
  async resumeSavedFlight(): Promise<void> {
    const s = readSavedFlight();
    if (!s) throw new Error('No saved flight');
    if (!(await this.sim.restoreFlight(s))) throw new Error('The saved flight could not be read');
  }
  setGroundSnow(mode: 'auto' | 'none' | 'full'): void { this.sim.setGroundSnow(mode); }
  groundSnow(): 'auto' | 'none' | 'full' { return this.sim.groundSnowMode; }
  setSeason(mode: 'auto' | 'summer' | 'autumn' | 'winter'): void { this.sim.setSeason(mode); }
  season(): 'auto' | 'summer' | 'autumn' | 'winter' { return this.sim.seasonMode; }
  setRandomFailures(on: boolean): void { this.sim.randomFailures = on; }
  randomFailures(): boolean { return this.sim.randomFailures; }

  abortActivity(): void { this.sim.activities.abort(); }
  restartActivity(): Promise<void> { return this.sim.activities.restart(); }
  restartActivityStep(): void { this.sim.activities.restartStep(); }
  /** The runner (phase, objectives, liveHint, result) and the persisted progress, read-only for the UI. */
  get activityRunner(): ActivityRunner { return this.sim.activities; }
  get activityProgress(): ProgressStore { return this.sim.activityProgress; }

  /** In flight the weather blends over 30 s; `immediate` (a new flight starting) applies it at once. */
  setWeatherPreset(id: WeatherPresetId, opts?: { immediate?: boolean }): void { this.sim.setWeatherPreset(id, this.sim.inFlight && !opts?.immediate ? 30 : 0); }
  setCustomWeather(w: WeatherState, opts?: { immediate?: boolean }): void {
    this.sim.weather.setState(w, this.sim.inFlight && !opts?.immediate ? 30 : 0);
    this.sim.events.emit('weather:changed', { state: this.sim.weather.state });
  }

  /** Magnetic variation (east +) for showing runway headings and bearings in °M, as MSFS does. */
  magneticVariationDeg(lat: number, lon: number): number { return magneticDeclinationDeg(lat, lon, 0, this.sim.time.utcMs); }

  /** COM1 frequencies for the ATC panel header. */
  comRadio(): { activeMHz: number; standbyMHz: number } | null {
    const c = this.sim.radios.state.com1;
    return c ? { activeMHz: c.activeMHz, standbyMHz: c.standbyMHz } : null;
  }

  /** Settings > General > Flight info strip: the HUD's flight-data tapes in external views. */
  infoStrip = true;
  setInfoStrip(visible: boolean): void { this.infoStrip = visible; }
  setInvertPitch(on: boolean): void { this.sim.invertPitch = on; }

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
    this.sim.dynRes.enabled = g.autoResolution !== false;
    this.sim.dynRes.reset();
    if (this.sim.dynRes.update(1 / 60)) this.sim.gfx.setDynamicScale(this.sim.dynRes.scale);
    this.sim.cameras.setFov(g.fov);
    this.sim.terrain?.setImagery(g.imagery);
    this.sim.terrain?.setDetail(g.terrainDetail);
    this.sim.sky.setShadowMapSize(QUALITY[g.quality].shadowMapSize);
    this.sim.sky.clouds.group.visible = g.clouds;
    this.sim.setShadows(g.shadows);
    this.sim.postFx.enabled = g.bloom !== false;
    this.sim.postFx.setAntialias(QUALITY[g.quality].antialias);
    this.sim.plugins.scenery?.setQuality?.(g.quality);
    this.sim.traffic.setMaxAircraft(g.quality === 'low' ? 1 : 2);
  }

  setAudio(a: AudioSettings): void { this.audioSettings = { ...a }; this.onAudioSettings?.(this.audioSettings); }
  setUnits(u: UnitsSettings): void { this.units = { ...u }; }
  get currentUnits(): UnitsSettings { return this.units; }

  flyingControls(): { title: string; keys: string[] }[] {
    // 'pitch −' is the push (nose down) binding: with game-style pitch it raises the nose
    const inv = this.sim.invertPitch;
    const titles: Record<string, string> = {
      'axis:pitch:-1': inv ? 'Nose up' : 'Nose down (push)', 'axis:pitch:1': inv ? 'Nose down' : 'Nose up (pull)',
      'axis:roll:-1': 'Bank left', 'axis:roll:1': 'Bank right',
      'axis:yaw:-1': 'Rudder / steer left', 'axis:yaw:1': 'Rudder / steer right',
      'axis:brakeLeft:1': 'Left brake', 'axis:brakeRight:1': 'Right brake',
      'axis:throttle': 'Throttle', 'axis:mixture': 'Mixture',
      'axis:lookYaw': 'Look left / right', 'axis:lookPitch': 'Look up / down', 'axis:cameraZoom': 'Zoom',
    };
    const order = Object.keys(titles);
    // neither aircraft has a constant-speed propeller or spoilers: leave those rows out of the help
    const rows = this.sim.input.controlsList().filter((r) => r.labels.length > 0 && !/^action:(propeller|spoilers)/.test(r.id));
    rows.sort((a, b) => { const i = order.indexOf(a.id), j = order.indexOf(b.id); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); });
    return rows.map((r) => ({ title: titles[r.id] ?? r.title, keys: r.labels }));
  }

  massState(): MassState | null {
    const cfg = this.sim.config, st = this.sim.fdm.state, l = this.sim.fdm.loads();
    const fuelCap = cfg.mass.tanks.reduce((a, t) => a + t.capacityKg, 0);
    return {
      stations: cfg.mass.stations.map((s, i) => ({ name: s.name, kg: l.stationKg[i] ?? 0, maxKg: s.maxKg })),
      fuelKg: l.tankKg.reduce((a, b) => a + b, 0), fuelCapKg: fuelCap, fuelKgPerGal: AVGAS_KG_PER_GAL,
      emptyKg: cfg.mass.emptyMassKg, mtowKg: cfg.mass.maxTakeoffKg,
      cgM: computeMassProperties(cfg, l.stationKg, l.tankKg).cg[0],
      cgLimitsM: cfg.mass.cgLimitsM ?? null,
      canLoad: this.sim.inFlight && st.onGround && st.groundSpeedMs < 0.5 && !st.crashed,
    };
  }

  previewMass(stationKg: number[], fuelFraction: number): { totalKg: number; cgM: number } | null {
    const cfg = this.sim.config;
    const f = Math.min(Math.max(fuelFraction, 0), 1);
    const mp = computeMassProperties(cfg, stationKg, cfg.mass.tanks.map((t) => t.capacityKg * f));
    return { totalKg: mp.mass, cgM: mp.cg[0] };
  }

  setLoad(stationKg: number[], fuelFraction: number): boolean {
    const st = this.sim.fdm.state;
    if (!this.sim.inFlight || !st.onGround || st.groundSpeedMs >= 0.5 || st.crashed) return false;
    this.sim.fdm.setLoad(stationKg);
    this.sim.fdm.setFuelFraction(fuelFraction);
    return true;
  }

  bindings(): BindingInfo[] {
    return this.sim.input.bindingsList().map((r) => ({ action: r.action, label: r.label, device: r.device, group: r.group, ...(r.labels.length > 1 ? { alt: r.labels.slice(1) } : {}) }));
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
    // OSM scenery: ODbL / OpenMapTiles / OpenFreeMap attribution when the plugin is loaded
    return [...base, ...terrain, ...(this.sim.plugins.scenery?.attribution?.() ?? [])];
  }

  captureInput(captured: boolean): void { this.sim.input.setCaptured(captured); }

  addWaypoint(wp: Waypoint): void { this.sim.planner.add(wp); }
  clearPlan(): void { this.sim.planner.clear(); }
  setPlan(waypoints: Waypoint[]): void { this.sim.planner.setWaypoints(waypoints); }

  /** Weather preset preview used by the World Map before a flight exists. */
  static presetPreview(id: WeatherPresetId, elevationM: number): WeatherState { return weatherFromPreset(id, elevationM); }
}

