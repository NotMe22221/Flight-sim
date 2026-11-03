/**
 * Persisted UI settings ('flightsim.settings.v1'): graphics, audio, units, assists, interface.
 * Pure except for the two localStorage accessors, which are guarded for Node/private mode.
 * Blob versions: 1 = first release; 2 = default FOV 70° (a stored legacy-default 75° is migrated)
 * and assists added later (anti-stall) are filled from the preset the saved ones match.
 */
import type { AssistanceOptions } from '../core/types';
import type { AudioSettings, GraphicsSettings, UnitsSettings } from './UiHost';
import { ASSIST_LEVELS, assistPreset } from './assistPresets';

export const SETTINGS_KEY = 'flightsim.settings.v1';
export const LAYOUT_KEY = 'flightsim.ui.layout.v1';
export const SELECTION_KEY = 'flightsim.ui.selection.v1';

/** UI-only preferences (accessibility): applied by UiManager, never sent to the host. */
export interface InterfaceSettings {
  /** CSS --ui-scale, 0.75..1.5 */ scale: number;
  /** ATC subtitles bottom-left while the ATC panel is closed */ subtitles: boolean;
  /** flight info strip outside the cockpit */ infoStrip: boolean;
}

export const SETTINGS_VERSION = 2;

export interface PersistedSettings {
  version: typeof SETTINGS_VERSION;
  graphics: GraphicsSettings;
  audio: AudioSettings;
  units: UnitsSettings;
  assists: AssistanceOptions;
  ui: InterfaceSettings;
}

export const GRAPHICS_QUALITY_PRESETS: Record<GraphicsSettings['quality'], Omit<GraphicsSettings, 'quality' | 'fov' | 'imagery'>> = {
  low: { renderScale: 0.75, shadows: false, clouds: false, terrainDetail: 0.5 },
  medium: { renderScale: 1, shadows: true, clouds: true, terrainDetail: 1 },
  high: { renderScale: 1, shadows: true, clouds: true, terrainDetail: 1.5 },
  ultra: { renderScale: 1.25, shadows: true, clouds: true, terrainDetail: 2 },
};

/** MSFS's default cockpit field of view; 75° made the C172's A-pillars look heavy. */
export const DEFAULT_FOV = 70;
/** The default before settings version 2: a stored 75 is migrated to DEFAULT_FOV on load. */
const LEGACY_DEFAULT_FOV = 75;
export const defaultGraphics = (): GraphicsSettings => ({ quality: 'medium', ...GRAPHICS_QUALITY_PRESETS.medium, imagery: 'satellite', fov: DEFAULT_FOV });
export const defaultAudio = (): AudioSettings => ({ master: 0.8, engine: 0.8, environment: 0.7, cockpit: 0.8, ui: 0.6, atc: 0.9 });
export const defaultUnitsSettings = (): UnitsSettings => ({ altitude: 'ft', speed: 'kt', pressure: 'inHg', distance: 'nm', temperature: 'C' });
export const defaultInterface = (): InterfaceSettings => ({ scale: 1, subtitles: true, infoStrip: true });
export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 1.5;
export const defaultSettings = (): PersistedSettings => ({
  version: SETTINGS_VERSION, graphics: defaultGraphics(), audio: defaultAudio(), units: defaultUnitsSettings(), assists: assistPreset('middle'), ui: defaultInterface(),
});

/** Applies a quality preset, keeping fov and imagery. */
export function applyGraphicsQuality(g: GraphicsSettings, quality: GraphicsSettings['quality']): GraphicsSettings {
  return { ...g, quality, ...GRAPHICS_QUALITY_PRESETS[quality] };
}

/** The preset the individual toggles currently match, or 'custom' as a label (quality field keeps its last value). */
export function detectGraphicsQuality(g: GraphicsSettings): GraphicsSettings['quality'] | 'custom' {
  for (const q of Object.keys(GRAPHICS_QUALITY_PRESETS) as GraphicsSettings['quality'][]) {
    const p = GRAPHICS_QUALITY_PRESETS[q];
    if (p.renderScale === g.renderScale && p.shadows === g.shadows && p.clouds === g.clouds && p.terrainDetail === g.terrainDetail) return q;
  }
  return 'custom';
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (typeof v === 'string' && (opts as readonly string[]).includes(v) ? (v as T) : d);

const assistKeys = Object.keys(assistPreset('middle')) as (keyof AssistanceOptions)[];

/**
 * Where assists missing from a saved blob (options added after it was written, e.g. anti-stall)
 * take their value from: the preset every saved option still matches ('All assists' players get the
 * new helper on, 'True to life' players off), else the default preset.
 */
function missingAssistBase(saved: Record<string, unknown>): AssistanceOptions {
  const present = assistKeys.filter((k) => typeof saved[k] === 'boolean');
  if (present.length === 0 || present.length === assistKeys.length) return assistPreset('middle');
  for (const lvl of ASSIST_LEVELS) {
    const p = assistPreset(lvl.id);
    if (present.every((k) => p[k] === saved[k])) return p;
  }
  return assistPreset('middle');
}

/** Merges unknown JSON onto defaults, field by field, so a stale or hand-edited blob can never break startup. */
export function sanitizeSettings(raw: unknown): PersistedSettings {
  const d = defaultSettings();
  if (!isObj(raw)) return d;
  const g = isObj(raw.graphics) ? raw.graphics : {};
  const a = isObj(raw.audio) ? raw.audio : {};
  const u = isObj(raw.units) ? raw.units : {};
  const s = isObj(raw.assists) ? raw.assists : {};
  const i = isObj(raw.ui) ? raw.ui : {};
  const vol = (k: keyof AudioSettings) => num(a[k], d.audio[k], 0, 1);
  // a version-1 blob still holding the old default FOV gets the new default (a deliberate 75 is rare)
  const legacy = raw.version !== SETTINGS_VERSION;
  const fov = num(g.fov, d.graphics.fov, 30, 120);
  const out: PersistedSettings = {
    version: SETTINGS_VERSION,
    graphics: {
      quality: oneOf(g.quality, ['low', 'medium', 'high', 'ultra'] as const, d.graphics.quality),
      renderScale: num(g.renderScale, d.graphics.renderScale, 0.5, 2),
      shadows: bool(g.shadows, d.graphics.shadows),
      clouds: bool(g.clouds, d.graphics.clouds),
      terrainDetail: num(g.terrainDetail, d.graphics.terrainDetail, 0.25, 4),
      imagery: oneOf(g.imagery, ['satellite', 'procedural'] as const, d.graphics.imagery),
      fov: legacy && fov === LEGACY_DEFAULT_FOV ? DEFAULT_FOV : fov,
    },
    audio: { master: vol('master'), engine: vol('engine'), environment: vol('environment'), cockpit: vol('cockpit'), ui: vol('ui'), atc: vol('atc') },
    units: {
      altitude: oneOf(u.altitude, ['ft', 'm'] as const, d.units.altitude),
      speed: oneOf(u.speed, ['kt', 'kmh', 'mph'] as const, d.units.speed),
      pressure: oneOf(u.pressure, ['inHg', 'hPa'] as const, d.units.pressure),
      distance: oneOf(u.distance, ['nm', 'km'] as const, d.units.distance),
      temperature: oneOf(u.temperature, ['C', 'F'] as const, d.units.temperature),
    },
    assists: { ...d.assists },
    ui: {
      scale: num(i.scale, d.ui.scale, UI_SCALE_MIN, UI_SCALE_MAX),
      subtitles: bool(i.subtitles, d.ui.subtitles),
      infoStrip: bool(i.infoStrip, d.ui.infoStrip),
    },
  };
  const base = missingAssistBase(s);
  for (const k of assistKeys) out.assists[k] = bool(s[k], base[k]);
  return out;
}

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function loadSettings(): PersistedSettings {
  const st = storage();
  if (!st) return defaultSettings();
  try {
    const raw = st.getItem(SETTINGS_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : defaultSettings();
  } catch { return defaultSettings(); }
}

export function saveSettings(s: PersistedSettings): void {
  const st = storage();
  if (!st) return;
  try { st.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* quota / private mode */ }
}

/** Generic JSON blob helpers for layout and last selection. */
export function loadJson<T>(key: string, fallback: T): T {
  const st = storage();
  if (!st) return fallback;
  try { const raw = st.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
export function saveJson(key: string, value: unknown): void {
  const st = storage();
  if (!st) return;
  try { st.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
