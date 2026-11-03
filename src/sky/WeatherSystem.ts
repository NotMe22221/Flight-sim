/**
 * Owns the current `WeatherState`, applies presets / METAR / live data with smooth transitions,
 * and answers the FDM's wind and cloud-density queries. No Three.js; emits no events (the
 * integrator fires `weather:changed` after calling `setPreset`/`applyMetar`/`applyLive`).
 */
import { clamp, deltaDeg, lerp, wrap360 } from '../core/math';
import type { CloudLayer, LocalFrameInfo, TurbulenceIntensity, Vec3, WeatherPresetId, WeatherState, WindLayer } from '../core/types';
import { KT } from '../core/units';
import { cloudDensityAt } from './cloudMath';
import { parseMetar, type MetarReport } from './metar';
import { cloneWeather, weatherFromPreset } from './presets';
import { GustModel, type GustModelOptions, WIND_REFERENCE_HEIGHT_M, Z0_DEFAULT, gustExcessAt, windAt } from './wind';

export interface WeatherSystemOptions {
  /** departure airport elevation, m MSL: preset layers are AGL here; default station elevation for METARs */
  airportElevationM?: number;
  /** RNG seed for gusts */ seed?: number;
  /** local NED frame (for `windNED`: altitude MSL = alt0 − down) */ frame?: LocalFrameInfo;
  /** ground height (local up, m) under a NED point, for the surface log profile; null when unknown */
  groundHeightUp?: (north: number, east: number) => number | null;
  /** roughness length, m */ z0?: number;
  /** initial preset (default 'clear') or explicit state */ initial?: WeatherPresetId | WeatherState;
  gust?: Partial<GustModelOptions>;
  /** default transition time for `setPreset`, s */ defaultTransitionS?: number;
}

/** What the FDM tells the weather each frame so gusts advance at the right rate. */
export interface AircraftAirState {
  /** true airspeed, m/s */ tasMs: number;
  altMslM: number;
  aglM: number;
}

export class WeatherSystem {
  /** Current weather. Mutated in place (transitions, live updates); safe to hold a reference. */
  readonly state: WeatherState;
  readonly gusts: GustModel;
  airportElevationM: number;
  frame: LocalFrameInfo | null;
  groundHeightUp: ((north: number, east: number) => number | null) | null;
  z0: number;
  defaultTransitionS: number;

  private from: WeatherState | null = null;
  private to: WeatherState | null = null;
  /** wind layers of `from`/`to` padded to equal length with virtual layers sampled from each side's own profile */
  private fromWinds: WindLayer[] = [];
  private toWinds: WindLayer[] = [];
  private elapsedS = 0;
  private durationS = 0;
  /** accumulated wind drift of each cloud layer's noise field: [dx, dz, …] (render frame: x East, z South), m */
  private readonly drifts: number[] = [];
  private readonly air: AircraftAirState = { tasMs: 0, altMslM: 0, aglM: 0 };
  private readonly meanWind: Vec3 = [0, 0, 0];
  private readonly gustVec: Vec3 = [0, 0, 0];

  constructor(options: WeatherSystemOptions = {}) {
    this.airportElevationM = options.airportElevationM ?? 0;
    this.frame = options.frame ?? null;
    this.groundHeightUp = options.groundHeightUp ?? null;
    this.z0 = options.z0 ?? Z0_DEFAULT;
    this.defaultTransitionS = options.defaultTransitionS ?? 60;
    this.gusts = new GustModel(options.seed ?? 7, options.gust);
    const init = options.initial ?? 'clear';
    this.state = typeof init === 'string' ? weatherFromPreset(init, this.airportElevationM) : cloneWeather(init);
    this.air.altMslM = this.airportElevationM;
  }

  /** true while a transition is in progress */
  get transitioning(): boolean { return this.to !== null; }
  /** 0..1 progress of the current transition (1 when idle) */
  get transitionProgress(): number { return this.to ? clamp(this.elapsedS / this.durationS, 0, 1) : 1; }
  /** The weather being transitioned to (or the current state when idle). */
  get target(): WeatherState { return this.to ?? this.state; }

  /**
   * New departure field elevation. Preset weather is defined above the field (cloud bases AGL, the
   * surface wind 10 m AGL), so its layers move with the field — a preset picked in the menu at sea
   * level keeps its 3,000 ft ceiling over a 5,000 ft airport. METAR, custom and live weather are
   * already MSL and stay put. A transition in progress shifts whichever side is a preset.
   */
  setAirportElevation(m: number): void {
    const d = m - this.airportElevationM;
    this.airportElevationM = m;
    if (d === 0 || !Number.isFinite(d)) return;
    const shift = (w: WeatherState | null): boolean => {
      if (!w || w.preset === 'custom' || w.preset === 'live') return false;
      for (const c of w.clouds) { c.baseM += d; c.topM += d; }
      for (const l of w.winds) l.altM += d;
      return true;
    };
    if (!this.to) { shift(this.state); return; }
    const a = shift(this.from), b = shift(this.to);
    if (a || b) { this.prepareLayerArrays(); this.step(0); }
  }
  setFrame(frame: LocalFrameInfo | null): void { this.frame = frame; }

  /** Switch to an MSFS-style preset, cross-fading over `transitionS` (0 = instant). */
  setPreset(id: WeatherPresetId, transitionS = this.defaultTransitionS): void {
    this.setState(weatherFromPreset(id, this.airportElevationM), transitionS);
  }

  /** Replace the weather with an explicit state (copied), optionally cross-fading. */
  setState(target: WeatherState, transitionS = 0): void {
    const t = cloneWeather(target);
    if (transitionS <= 0) {
      assignWeather(this.state, t);
      this.from = this.to = null;
      return;
    }
    this.from = cloneWeather(this.state);
    this.to = t;
    this.elapsedS = 0;
    this.durationS = transitionS;
    // Discrete fields switch immediately so the UI and precipitation type reflect the new target
    this.state.preset = t.preset;
    if (t.precipitationRate > 0) this.state.precipitationType = t.precipitationType;
    this.prepareLayerArrays();
    this.step(0);
  }

  /** Parse a METAR and apply it. Returns the report (with `unparsed` tokens for diagnostics). */
  applyMetar(raw: string, stationElevationM = this.airportElevationM, transitionS = 0): MetarReport {
    const rep = parseMetar(raw, stationElevationM);
    this.setState(rep.weather, transitionS);
    return rep;
  }

  /** Apply a live `WeatherState` (e.g. from `fetchOpenMeteo`). */
  applyLive(ws: WeatherState, transitionS = 30): void {
    const t = cloneWeather(ws);
    t.preset = 'live';
    this.setState(t, transitionS);
  }

  /**
   * Advance transitions, gusts and cloud drift.
   * @param dt sim seconds
   * @param air optional aircraft air data (TAS / altitude) so the gust envelope advances at the right rate
   */
  update(dt: number, air?: AircraftAirState): void {
    if (air) { this.air.tasMs = air.tasMs; this.air.altMslM = air.altMslM; this.air.aglM = air.aglM; }
    if (this.to) this.step(dt);
    // gusts along the mean wind at the aircraft altitude
    const mean = windAt(this.state.winds, this.air.altMslM, this.air.aglM, this.meanWind, this.z0);
    const excess = gustExcessAt(this.state.winds, this.air.altMslM);
    const rel = Math.max(this.air.tasMs, Math.hypot(mean[0], mean[1]), 3);
    this.gusts.update(dt, rel, excess, mean);
    // cloud drift: each layer's noise field is advected by the wind at its mid-height
    const layers = this.state.clouds;
    for (let i = 0; i < layers.length; i++) {
      const mid = 0.5 * (layers[i].baseM + layers[i].topM);
      windAt(this.state.winds, mid, Math.max(mid - this.airportElevationM, 10), this.meanWind, this.z0);
      // NED (n, e) → render (x = E, z = −N)
      this.drifts[i * 2] = (this.drifts[i * 2] ?? 0) + this.meanWind[1] * dt;
      this.drifts[i * 2 + 1] = (this.drifts[i * 2 + 1] ?? 0) - this.meanWind[0] * dt;
    }
  }

  /** Mean wind + discrete gust at an altitude, NED m/s (velocity: the direction the air moves toward). */
  windAtAltitude(altMslM: number, aglM: number, out: Vec3 = [0, 0, 0]): Vec3 {
    windAt(this.state.winds, altMslM, aglM, out, this.z0);
    const g = this.gusts.gustNED(this.gustVec);
    out[0] += g[0]; out[1] += g[1]; out[2] += g[2];
    return out;
  }

  /**
   * Wind velocity at a local-NED point — the `EnvironmentSources.windNED` signature, so the World
   * can wire `windNED: (n, e, d, out) => weather.windNED(n, e, d, out)` straight into the FDM.
   */
  windNED(north: number, east: number, down: number, out: Vec3): Vec3 {
    const alt0 = this.frame?.alt0 ?? this.airportElevationM;
    const altMsl = alt0 - down;
    const groundUp = this.groundHeightUp?.(north, east);
    const agl = groundUp !== null && groundUp !== undefined ? -down - groundUp : altMsl - this.airportElevationM;
    return this.windAtAltitude(altMsl, agl, out);
  }

  /**
   * Wind velocity (NED, m/s, the direction the air moves TOWARD) at a local-NED position: mean wind
   * with the surface log profile + the active discrete gust. Pass `out` in per-frame code.
   */
  windAt(posNED: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 {
    return this.windNED(posNED[0], posNED[1], posNED[2], out);
  }

  /** Cloud density 0..1 at a render-frame point (x East, y Up MSL, z South). */
  cloudDensityAt(x: number, y: number, z: number): number {
    return cloudDensityAt(this.state.clouds, x, y, z, this.drifts);
  }

  /** Cloud density 0..1 at a local-NED point (altitude MSL = alt0 − down). */
  cloudDensityAtNED(north: number, east: number, down: number): number {
    const alt0 = this.frame?.alt0 ?? this.airportElevationM;
    return this.cloudDensityAt(east, alt0 - down, -north);
  }

  /** Accumulated noise-field drift per cloud layer ([dx, dz, …], render frame, m) — the renderer uses the same offsets. */
  get cloudDrifts(): readonly number[] { return this.drifts; }

  /** Shift drift offsets when the floating origin moves by `(dxEast, dzSouth)` so cloud fields stay put. */
  notifyRebase(dxEast: number, dzSouth: number): void {
    for (let i = 0; i < this.drifts.length; i += 2) { this.drifts[i] -= dxEast; this.drifts[i + 1] -= dzSouth; }
  }

  // ───────────────────────────── transitions ─────────────────────────────

  private prepareLayerArrays(): void {
    const from = this.from!, to = this.to!;
    const nc = Math.max(from.clouds.length, to.clouds.length);
    const nw = Math.max(from.winds.length, to.winds.length);
    const s = this.state;
    while (s.clouds.length < nc) s.clouds.push({ baseM: 0, topM: 0, coverage: 0, density: 0, type: 'cumulus' });
    s.clouds.length = nc;
    while (s.winds.length < nw) s.winds.push({ altM: 0, directionDeg: 0, speedKt: 0, gustKt: 0 });
    s.winds.length = nw;
    // Unmatched wind layers blend toward the OTHER profile's wind at their altitude, so the profile is
    // exactly `from` at t = 0 and exactly `to` at t = 1 (dropping the virtual layers then is seamless).
    this.fromWinds = padWindLayers(from.winds, to.winds);
    this.toWinds = padWindLayers(to.winds, from.winds);
  }

  private step(dt: number): void {
    const from = this.from!, to = this.to!, s = this.state;
    this.elapsedS += dt;
    const t = this.durationS > 0 ? clamp(this.elapsedS / this.durationS, 0, 1) : 1;
    const k = t * t * (3 - 2 * t); // smoothstep easing
    s.precipitationRate = lerp(from.precipitationRate, to.precipitationRate, k);
    s.humidity = lerp(from.humidity, to.humidity, k);
    s.qnhPa = lerp(from.qnhPa, to.qnhPa, k);
    s.temperatureC = lerp(from.temperatureC, to.temperatureC, k);
    s.aerosol = lerp(from.aerosol, to.aerosol, k);
    s.visibilityM = Math.exp(lerp(Math.log(Math.max(from.visibilityM, 10)), Math.log(Math.max(to.visibilityM, 10)), k));
    s.fogTopM = lerp(from.fogTopM, to.fogTopM, k);
    if (k >= 0.5) { s.thunderstorm = to.thunderstorm; s.turbulence = to.turbulence; s.precipitationType = to.precipitationType; }
    else { s.thunderstorm = from.thunderstorm; s.turbulence = from.turbulence; if (to.precipitationRate <= 0) s.precipitationType = from.precipitationType; }
    for (let i = 0; i < s.clouds.length; i++) lerpCloud(from.clouds[i], to.clouds[i], k, s.clouds[i]);
    for (let i = 0; i < s.winds.length; i++) lerpWind(this.fromWinds[i], this.toWinds[i], k, s.winds[i]);
    sortWindLayers(s.winds);
    if (t >= 1) {
      assignWeather(s, to);
      this.drifts.length = Math.min(this.drifts.length, s.clouds.length * 2);
      this.from = this.to = null;
    }
  }
}

/** Copy `src` into `dst` in place (layers copied). */
export function assignWeather(dst: WeatherState, src: WeatherState): void {
  dst.preset = src.preset;
  dst.precipitationRate = src.precipitationRate;
  dst.precipitationType = src.precipitationType;
  dst.thunderstorm = src.thunderstorm;
  dst.humidity = src.humidity;
  dst.qnhPa = src.qnhPa;
  dst.temperatureC = src.temperatureC;
  dst.aerosol = src.aerosol;
  dst.visibilityM = src.visibilityM;
  dst.turbulence = src.turbulence as TurbulenceIntensity;
  dst.fogTopM = src.fogTopM;
  dst.clouds.length = src.clouds.length;
  for (let i = 0; i < src.clouds.length; i++) dst.clouds[i] = { ...src.clouds[i] };
  dst.winds.length = src.winds.length;
  for (let i = 0; i < src.winds.length; i++) dst.winds[i] = { ...src.winds[i] };
}

function lerpCloud(a: CloudLayer | undefined, b: CloudLayer | undefined, k: number, out: CloudLayer): void {
  // A missing side fades through zero coverage at the other side's geometry (no allocation per frame).
  const fa = a ?? b, fb = b ?? a;
  if (!fa || !fb) return;
  out.baseM = lerp(fa.baseM, fb.baseM, k);
  out.topM = lerp(fa.topM, fb.topM, k);
  out.coverage = lerp(a ? a.coverage : 0, b ? b.coverage : 0, k);
  out.density = lerp(fa.density, fb.density, k);
  out.type = k < 0.5 ? fa.type : fb.type;
}

function lerpWind(a: WindLayer | undefined, b: WindLayer | undefined, k: number, out: WindLayer): void {
  const fa = a ?? b, fb = b ?? a;
  if (!fa || !fb) return;
  out.altM = lerp(fa.altM, fb.altM, k);
  out.speedKt = lerp(fa.speedKt, fb.speedKt, k);
  out.gustKt = lerp(fa.gustKt, fb.gustKt, k);
  out.directionDeg = wrap360(fa.directionDeg + deltaDeg(fb.directionDeg, fa.directionDeg) * k);
}

const padScratch: Vec3 = [0, 0, 0];

/** `own` followed by virtual layers at `other`'s extra altitudes, sampled from `own`'s profile (FROM deg, kt). */
function padWindLayers(own: readonly WindLayer[], other: readonly WindLayer[]): WindLayer[] {
  const out = own.map((l) => ({ ...l }));
  for (let i = own.length; i < other.length; i++) {
    const altM = other[i].altM;
    const v = windAt(own, altM, WIND_REFERENCE_HEIGHT_M, padScratch);
    const speedKt = Math.hypot(v[0], v[1]) / KT;
    const excessKt = gustExcessAt(own, altM) / KT;
    out.push({ altM, directionDeg: wrap360((Math.atan2(v[1], v[0]) * 180) / Math.PI + 180), speedKt, gustKt: excessKt > 0 ? speedKt + excessKt : 0 });
  }
  return out;
}

/** In-place insertion sort by altitude (`windAt` needs ascending layers; no allocation). */
function sortWindLayers(layers: WindLayer[]): void {
  for (let i = 1; i < layers.length; i++) {
    const l = layers[i];
    let j = i - 1;
    while (j >= 0 && layers[j].altM > l.altM) { layers[j + 1] = layers[j]; j--; }
    layers[j + 1] = l;
  }
}

/** Convenience: wind speed (m/s) of a layer. */
export const layerSpeedMs = (l: WindLayer): number => l.speedKt * KT;
