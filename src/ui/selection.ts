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
import { weatherPresetLabel, weatherPresetTemplate } from './weatherPresets';

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

interface PersistedSelection { icao?: string; endIdent?: string | null; aircraftId?: string; fuelFraction?: number; payloadKg?: number; weather?: WeatherSelection; time?: TimeSelection; arrivalIcao?: string | null }

export class SelectionStore {
  sel: FlightSelection;
  private listeners = new Set<(s: FlightSelection) => void>();

  constructor(private readonly host: UiHost) {
    const saved = loadJson<PersistedSelection>(SELECTION_KEY, {});
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
      weather: saved.weather && isWeatherSel(saved.weather) ? saved.weather : { mode: 'preset', presetId: 'clear' },
      time: saved.time && isTimeSel(saved.time) ? saved.time : { mode: 'now' },
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
function isWeatherSel(w: unknown): w is WeatherSelection {
  if (typeof w !== 'object' || w === null) return false;
  const m = (w as { mode?: unknown }).mode;
  return m === 'preset' || m === 'live' || (m === 'custom' && typeof (w as { custom?: unknown }).custom === 'object');
}
function isTimeSel(t: unknown): t is TimeSelection {
  if (typeof t !== 'object' || t === null) return false;
  const m = (t as { mode?: unknown }).mode;
  return m === 'now' || m === 'preset' || (m === 'custom' && typeof (t as { utcMs?: unknown }).utcMs === 'number');
}
