/**
 * Pre-flight selection shared by Main Menu, World Map, Aircraft and Weather screens:
 * departure (airport + runway end or parking), aircraft, fuel/payload, weather, time.
 */
import type { Airport, WeatherPresetId, WeatherState } from '../core/types';
import type { SpawnChoice, UiHost } from './UiHost';
import { FALLBACK_KSFO, findRunwayEnd } from './runways';
import { SELECTION_KEY, loadJson, saveJson } from './settingsStore';
import { timeForPreset, type TimePreset } from './solar';
import { formatTimeLocal, formatTimeUtc, timezoneOffsetFromLon } from './format';
import { WEATHER_PRESET_IDS, validateCustomWeather, weatherPresetLabel, weatherPresetTemplate } from './weatherPresets';

/** 'Cessna 172S Skyhawk' — the manufacturer is prefixed only when the name does not already start with it. */
export function aircraftDisplayName(manufacturer: string, name: string): string {
  const m = manufacturer.trim();
  return !m || name.toLowerCase().startsWith(m.toLowerCase()) ? name : `${m} ${name}`;
}

export type WeatherSelection = { mode: 'preset'; presetId: WeatherPresetId } | { mode: 'live' } | { mode: 'custom'; custom: WeatherState };
export type TimeSelection = { mode: 'now' } | { mode: 'preset'; preset: TimePreset } | { mode: 'custom'; utcMs: number };

export interface FlightSelection {
  spawn: SpawnChoice;
  aircraftId: string;
  /** 0..1 of total capacity */ fuelFraction: number;
  payloadKg: number;
  weather: WeatherSelection;
  time: TimeSelection;
  /** World Map "Set as arrival": added to the flight plan once the flight is live. */
  arrival: Airport | null;
}

export interface PersistedSelection { icao?: string; endIdent?: string | null; aircraftId?: string; fuelFraction?: number; payloadKg?: number; weather?: WeatherSelection; time?: TimeSelection; arrivalIcao?: string | null }

export class SelectionStore {
  sel: FlightSelection;
  private listeners = new Set<(s: FlightSelection) => void>();

  constructor(private readonly host: UiHost) {
    // a stale or hand-edited blob must never break startup: every field is checked before use
    const saved = parsePersistedSelection(loadJson<unknown>(SELECTION_KEY, {}));
    const airport = (saved.icao && host.nav.getAirport(saved.icao)) || host.nav.getAirport('KSFO') || FALLBACK_KSFO;
    let runwayEnd = saved.endIdent === null ? null : findRunwayEnd(airport, saved.endIdent ?? '28R');
    if (runwayEnd === null && saved.endIdent !== null) runwayEnd = airport.runways.length ? findRunwayEnd(airport, airport.runways[0].ident) : null;
    const list = host.aircraftList();
    const aircraftId = (saved.aircraftId && list.some((a) => a.id === saved.aircraftId) ? saved.aircraftId : null)
      ?? list.find((a) => /c172|172/i.test(a.id))?.id ?? list[0]?.id ?? 'c172';
    this.sel = {
      spawn: { airport, runwayEnd, coldAndDark: runwayEnd === null },
      aircraftId,
      fuelFraction: clamp01(saved.fuelFraction ?? 0.75),
      payloadKg: Math.max(0, saved.payloadKg ?? 170),
      weather: saved.weather ?? { mode: 'preset', presetId: 'clear' },
      time: saved.time ?? { mode: 'now' },
      arrival: (typeof saved.arrivalIcao === 'string' && host.nav.getAirport(saved.arrivalIcao)) || null,
    };
  }

  onChange(fn: (s: FlightSelection) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  set(patch: Partial<FlightSelection>): void {
    this.sel = { ...this.sel, ...patch };
    if (patch.spawn) this.sel.spawn = { ...patch.spawn, coldAndDark: patch.spawn.runwayEnd === null ? true : patch.spawn.coldAndDark };
    this.persist();
    for (const l of Array.from(this.listeners)) { try { l(this.sel); } catch (e) { console.error('[ui] selection listener threw', e); } }
  }

  private persist(): void {
    const s = this.sel;
    const p: PersistedSelection = {
      icao: s.spawn.airport.icao, endIdent: s.spawn.runwayEnd ? s.spawn.runwayEnd.endIdent : null, aircraftId: s.aircraftId,
      fuelFraction: s.fuelFraction, payloadKg: s.payloadKg, weather: s.weather, time: s.time, arrivalIcao: s.arrival ? s.arrival.icao : null,
    };
    saveJson(SELECTION_KEY, p);
  }

  /** Absolute UTC instant for the current time selection (resolved for the departure airport). */
  resolvedTimeUtcMs(nowMs = Date.now()): number {
    const t = this.sel.time;
    if (t.mode === 'now') return nowMs;
    if (t.mode === 'custom') return t.utcMs;
    const p = this.sel.spawn.airport.position;
    return timeForPreset(t.preset, nowMs, p.lat, p.lon);
  }

  /** The WeatherState to send for a custom selection, or a template for a preset. */
  weatherState(): WeatherState {
    const w = this.sel.weather;
    if (w.mode === 'custom') return w.custom;
    if (w.mode === 'preset') return weatherPresetTemplate(w.presetId);
    const live = weatherPresetTemplate('clear');
    live.preset = 'live';
    return live;
  }

  /** Pushes the weather and time selection to the host (pre-flight preview and before spawn). */
  applyEnvironment(): void {
    const w = this.sel.weather;
    if (w.mode === 'preset') this.host.setWeatherPreset(w.presetId);
    else if (w.mode === 'custom') this.host.setCustomWeather(w.custom);
    else void this.host.requestLiveWeather();
    this.host.setTime(this.resolvedTimeUtcMs());
  }

  describe(): { airport: string; runway: string; aircraft: string; weather: string; time: string; arrival: string } {
    const s = this.sel;
    const ac = this.host.aircraftList().find((a) => a.id === s.aircraftId);
    const t = this.resolvedTimeUtcMs();
    const off = timezoneOffsetFromLon(s.spawn.airport.position.lon);
    const timeLabel = s.time.mode === 'now' ? 'Now' : s.time.mode === 'preset' ? s.time.preset.charAt(0).toUpperCase() + s.time.preset.slice(1) : 'Custom';
    return {
      airport: `${s.spawn.airport.icao} · ${s.spawn.airport.name}`,
      runway: s.spawn.runwayEnd ? `Runway ${s.spawn.runwayEnd.endIdent}` : 'Parking · cold & dark',
      aircraft: ac ? aircraftDisplayName(ac.manufacturer, ac.name) : s.aircraftId,
      weather: s.weather.mode === 'live' ? 'Live weather' : s.weather.mode === 'custom' ? 'Custom' : weatherPresetLabel(s.weather.presetId),
      time: `${timeLabel} · ${formatTimeLocal(t, off)} local (${formatTimeUtc(t)})`,
      arrival: s.arrival ? `${s.arrival.icao} · ${s.arrival.name}` : 'None',
    };
  }
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.75);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const TIME_PRESETS: readonly string[] = ['dawn', 'noon', 'dusk', 'night'];

function parseWeatherSel(w: unknown): WeatherSelection | undefined {
  if (!isObj(w)) return undefined;
  if (w.mode === 'live') return { mode: 'live' };
  if (w.mode === 'preset') return typeof w.presetId === 'string' && (WEATHER_PRESET_IDS as readonly string[]).includes(w.presetId) ? { mode: 'preset', presetId: w.presetId as WeatherPresetId } : undefined;
  if (w.mode !== 'custom' || !isObj(w.custom)) return undefined;
  const c = w.custom;
  if (!Array.isArray(c.clouds) || !Array.isArray(c.winds) || !c.clouds.every(isObj) || !c.winds.every(isObj)) return undefined;
  // fills missing scalars from a template, then clamps/sorts like the custom editor's Apply
  const merged = { ...weatherPresetTemplate('clear'), ...(c as unknown as Partial<WeatherState>) } as WeatherState;
  try { return { mode: 'custom', custom: validateCustomWeather(merged).fixed }; } catch { return undefined; }
}

function parseTimeSel(t: unknown): TimeSelection | undefined {
  if (!isObj(t)) return undefined;
  if (t.mode === 'now') return { mode: 'now' };
  if (t.mode === 'preset') return typeof t.preset === 'string' && TIME_PRESETS.includes(t.preset) ? { mode: 'preset', preset: t.preset as TimePreset } : undefined;
  const utcMs = finite(t.utcMs);
  return t.mode === 'custom' && utcMs !== undefined ? { mode: 'custom', utcMs } : undefined;
}

/** Field-by-field check of the saved selection (anything malformed falls back to the default). */
export function parsePersistedSelection(raw: unknown): PersistedSelection {
  if (!isObj(raw)) return {};
  const out: PersistedSelection = {};
  if (typeof raw.icao === 'string' && raw.icao) out.icao = raw.icao;
  if (raw.endIdent === null || (typeof raw.endIdent === 'string' && raw.endIdent)) out.endIdent = raw.endIdent;
  if (typeof raw.aircraftId === 'string') out.aircraftId = raw.aircraftId;
  const fuel = finite(raw.fuelFraction); if (fuel !== undefined) out.fuelFraction = fuel;
  const payload = finite(raw.payloadKg); if (payload !== undefined) out.payloadKg = payload;
  const w = parseWeatherSel(raw.weather); if (w) out.weather = w;
  const t = parseTimeSel(raw.time); if (t) out.time = t;
  if (raw.arrivalIcao === null || typeof raw.arrivalIcao === 'string') out.arrivalIcao = raw.arrivalIcao;
  return out;
}
