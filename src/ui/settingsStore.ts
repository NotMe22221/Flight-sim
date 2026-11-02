/**
 * Persisted UI settings ('flightsim.settings.v1'): graphics, audio, units, assists.
 * Pure except for the two localStorage accessors, which are guarded for Node/private mode.
 */
import type { AssistanceOptions } from '../core/types';
import type { AudioSettings, GraphicsSettings, UnitsSettings } from './UiHost';
import { assistPreset } from './assistPresets';

export const SETTINGS_KEY = 'flightsim.settings.v1';
export const LAYOUT_KEY = 'flightsim.ui.layout.v1';
export const SELECTION_KEY = 'flightsim.ui.selection.v1';

export interface PersistedSettings {
  version: 1;
  graphics: GraphicsSettings;
  audio: AudioSettings;
  units: UnitsSettings;
  assists: AssistanceOptions;
}

export const GRAPHICS_QUALITY_PRESETS: Record<GraphicsSettings['quality'], Omit<GraphicsSettings, 'quality' | 'fov' | 'imagery'>> = {
  low: { renderScale: 0.75, shadows: false, clouds: false, terrainDetail: 0.5 },
  medium: { renderScale: 1, shadows: true, clouds: true, terrainDetail: 1 },
  high: { renderScale: 1, shadows: true, clouds: true, terrainDetail: 1.5 },
  ultra: { renderScale: 1.25, shadows: true, clouds: true, terrainDetail: 2 },
};

export const defaultGraphics = (): GraphicsSettings => ({ quality: 'medium', ...GRAPHICS_QUALITY_PRESETS.medium, imagery: 'satellite', fov: 75 });
export const defaultAudio = (): AudioSettings => ({ master: 0.8, engine: 0.8, environment: 0.7, cockpit: 0.8, ui: 0.6, atc: 0.9 });
export const defaultUnitsSettings = (): UnitsSettings => ({ altitude: 'ft', speed: 'kt', pressure: 'inHg', distance: 'nm', temperature: 'C' });
export const defaultSettings = (): PersistedSettings => ({
  version: 1, graphics: defaultGraphics(), audio: defaultAudio(), units: defaultUnitsSettings(), assists: assistPreset('middle'),
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

/** Merges unknown JSON onto defaults, field by field, so a stale or hand-edited blob can never break startup. */
export function sanitizeSettings(raw: unknown): PersistedSettings {
  const d = defaultSettings();
  if (!isObj(raw)) return d;
  const g = isObj(raw.graphics) ? raw.graphics : {};
  const a = isObj(raw.audio) ? raw.audio : {};
  const u = isObj(raw.units) ? raw.units : {};
  const s = isObj(raw.assists) ? raw.assists : {};
  const vol = (k: keyof AudioSettings) => num(a[k], d.audio[k], 0, 1);
  const out: PersistedSettings = {
    version: 1,
    graphics: {
      quality: oneOf(g.quality, ['low', 'medium', 'high', 'ultra'] as const, d.graphics.quality),
      renderScale: num(g.renderScale, d.graphics.renderScale, 0.5, 2),
      shadows: bool(g.shadows, d.graphics.shadows),
      clouds: bool(g.clouds, d.graphics.clouds),
      terrainDetail: num(g.terrainDetail, d.graphics.terrainDetail, 0.25, 4),
      imagery: oneOf(g.imagery, ['satellite', 'procedural'] as const, d.graphics.imagery),
      fov: num(g.fov, d.graphics.fov, 30, 120),
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
  };
  for (const k of Object.keys(d.assists) as (keyof AssistanceOptions)[]) out.assists[k] = bool(s[k], d.assists[k]);
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
