/**
 * src/ui — MSFS-style menus, World Map, settings, activities and in-flight toolbar/panels.
 * Importing this barrel also loads the single stylesheet (ui.css).
 *
 *   import { UiManager } from './ui';
 *   const ui = new UiManager(container, host);   // host implements UiHost
 *   ui.onStart(() => audio.resume());
 *   // per frame: ui.update(snapshot, dt); discrete actions: ui.handleAction(action)
 */
import './ui.css';

export { UiManager, type UiScreen } from './UiManager';
export type { UiHost, SpawnChoice, RunwayEndChoice, GraphicsSettings, AudioSettings, UnitsSettings, BindingInfo } from './UiHost';
export type { ScreenId, ScreenContext } from './screens/Screen';
export { Screen, screenHeader } from './screens/Screen';

// Pure helpers useful to integrators and tests.
export { ScreenRouter, EscapeDeduper, shouldCaptureInput } from './routing';
export { SelectionStore, type FlightSelection, type WeatherSelection, type TimeSelection } from './selection';
export {
  SETTINGS_KEY, LAYOUT_KEY, SELECTION_KEY, defaultSettings, loadSettings, saveSettings, sanitizeSettings,
  type PersistedSettings, type InterfaceSettings,
} from './settingsStore';
export { settingsReducer, type SettingsAction, type SettingsGroup, type SettingsTab } from './settingsModel';
export { ASSIST_ITEMS, ASSIST_LEVELS, assistPreset, detectAssistLevel } from './assistPresets';
export { WEATHER_PRESETS, weatherPresetTemplate, weatherSummary } from './weatherPresets';
export { BEST_SCORES_KEY, landingChallenges, loadBestScores } from './activities';
export * as format from './format';
