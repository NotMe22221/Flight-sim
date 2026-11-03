/**
 * Pure state for the Settings screen: tab list/cycling, unit systems, the settings reducer
 * (which reports the groups that actually changed so UiManager only pushes those to the host),
 * and the assistance rows that always show the *effective* per-item state (doc 01 §1.2).
 */
import type { AssistLevel, AssistanceOptions } from '../core/types';
import type { AudioSettings, GraphicsSettings, UnitsSettings } from './UiHost';
import { ASSIST_ITEMS, REALISM_KEYS, assistPreset, detectAssistLevel, type AssistItemMeta, type AssistKey } from './assistPresets';
import { UI_SCALE_MAX, UI_SCALE_MIN, applyGraphicsQuality, defaultSettings, detectGraphicsQuality, sanitizeSettings, type InterfaceSettings, type PersistedSettings } from './settingsStore';

// ─── tabs ─────────────────────────────────────────────────────────────────────

export type SettingsTab = 'general' | 'graphics' | 'controls' | 'audio' | 'data';

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'controls', label: 'Controls' },
  { id: 'audio', label: 'Audio' },
  { id: 'data', label: 'Data & credits' },
];

/** A remembered tab id, or 'general' for anything unknown. */
export function parseTab(v: unknown): SettingsTab {
  return SETTINGS_TABS.some((t) => t.id === v) ? (v as SettingsTab) : 'general';
}

/** Next/previous tab with wrap-around (← → on the tab bar, Q/E on a gamepad-like flow). */
export function cycleTab(current: SettingsTab, dir: 1 | -1): SettingsTab {
  const i = SETTINGS_TABS.findIndex((t) => t.id === current);
  const n = SETTINGS_TABS.length;
  return SETTINGS_TABS[((i < 0 ? 0 : i) + dir + n) % n].id;
}

// ─── units ────────────────────────────────────────────────────────────────────

export type UnitSystem = 'imperial' | 'metric';

/** Aviation imperial (ft, kt, inHg, nm) and metric (m, km/h, hPa, km); both °C. */
export const UNIT_SYSTEMS: Record<UnitSystem, UnitsSettings> = {
  imperial: { altitude: 'ft', speed: 'kt', pressure: 'inHg', distance: 'nm', temperature: 'C' },
  metric: { altitude: 'm', speed: 'kmh', pressure: 'hPa', distance: 'km', temperature: 'C' },
};

export function unitSystemOf(u: UnitsSettings): UnitSystem | 'custom' {
  for (const k of Object.keys(UNIT_SYSTEMS) as UnitSystem[]) if (sameFlat(UNIT_SYSTEMS[k], u)) return k;
  return 'custom';
}

// ─── reducer ──────────────────────────────────────────────────────────────────

export type SettingsGroup = 'graphics' | 'audio' | 'units' | 'assists' | 'ui';
export const SETTINGS_GROUPS: SettingsGroup[] = ['graphics', 'audio', 'units', 'assists', 'ui'];

export type SettingsAction =
  | { type: 'units'; patch: Partial<UnitsSettings> }
  | { type: 'unitSystem'; system: UnitSystem }
  | { type: 'assistLevel'; level: AssistLevel }
  | { type: 'assist'; key: AssistKey; value: boolean }
  | { type: 'assistsReplace'; assists: AssistanceOptions }
  | { type: 'graphicsQuality'; quality: GraphicsSettings['quality'] }
  | { type: 'graphics'; patch: Partial<Omit<GraphicsSettings, 'quality'>> }
  | { type: 'audio'; key: keyof AudioSettings; value: number }
  | { type: 'ui'; patch: Partial<InterfaceSettings> }
  | { type: 'reset'; group: SettingsGroup }
  | { type: 'resetAll' };

export interface SettingsResult {
  next: PersistedSettings;
  /** groups whose values differ from the input (push only these to the host) */
  changed: SettingsGroup[];
}

/** Applies one user action; the input is never mutated and the output is always sanitized. */
export function settingsReducer(s: PersistedSettings, a: SettingsAction): SettingsResult {
  const n: PersistedSettings = { ...s };
  switch (a.type) {
    case 'units': n.units = { ...s.units, ...a.patch }; break;
    case 'unitSystem': n.units = { ...UNIT_SYSTEMS[a.system] }; break;
    case 'assistLevel': n.assists = assistPreset(a.level); break;
    case 'assist': n.assists = { ...s.assists, [a.key]: a.value }; break;
    case 'assistsReplace': n.assists = { ...a.assists }; break;
    case 'graphicsQuality': n.graphics = applyGraphicsQuality(s.graphics, a.quality); break;
    case 'graphics': n.graphics = { ...s.graphics, ...a.patch }; break;
    case 'audio': n.audio = { ...s.audio, [a.key]: a.value }; break;
    case 'ui': n.ui = { ...s.ui, ...a.patch, scale: clampScale(a.patch.scale ?? s.ui.scale) }; break;
    case 'reset': { const d = defaultSettings(); (n as unknown as Record<SettingsGroup, unknown>)[a.group] = d[a.group]; break; }
    case 'resetAll': return diff(s, defaultSettings());
  }
  return diff(s, sanitizeSettings(n));
}

function diff(prev: PersistedSettings, next: PersistedSettings): SettingsResult {
  const changed = SETTINGS_GROUPS.filter((g) => !sameFlat(prev[g] as unknown as Record<string, unknown>, next[g] as unknown as Record<string, unknown>));
  return { next, changed };
}

const clampScale = (v: number) => (Number.isFinite(v) ? Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, v)) : 1);

/** Shallow equality of two flat settings objects (all settings groups are flat). */
export function sameFlat<T extends object>(a: T, b: T): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  return true;
}

// ─── view helpers ─────────────────────────────────────────────────────────────

export interface AssistRow extends AssistItemMeta {
  /** effective state right now */ value: boolean;
  /** true for realism flags (damage, drift) where ON means *harder* */ realism: boolean;
  /** 'ON' / 'OFF' text shown next to the switch */ effective: string;
}

export interface AssistView {
  /** the preset the toggles match, or 'custom' */ level: AssistLevel | 'custom';
  categories: { category: AssistItemMeta['category']; rows: AssistRow[] }[];
  /** helpers (non-realism) currently on */ helpersOn: number;
}

/** Everything the General tab renders for assistance, grouped by MSFS category. */
export function assistView(a: AssistanceOptions): AssistView {
  const categories: AssistView['categories'] = [];
  let helpersOn = 0;
  for (const it of ASSIST_ITEMS) {
    const realism = REALISM_KEYS.has(it.key);
    const value = a[it.key];
    if (!realism && value) helpersOn++;
    let cat = categories.find((c) => c.category === it.category);
    if (!cat) { cat = { category: it.category, rows: [] }; categories.push(cat); }
    cat.rows.push({ ...it, value, realism, effective: value ? 'ON' : 'OFF' });
  }
  return { level: detectAssistLevel(a), categories, helpersOn };
}

/** 'Medium', or 'Custom (Medium base)' when the toggles no longer match a preset. */
export function graphicsQualityLabel(g: GraphicsSettings): string {
  const q = detectGraphicsQuality(g);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return q === 'custom' ? `Custom (${cap(g.quality)} base)` : cap(q);
}
