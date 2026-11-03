/**
 * Binding persistence in localStorage under 'flightsim.bindings.v1'. Every access is
 * guarded (private mode, disabled storage, Node) and corrupt data falls back to defaults.
 */
import { type BindingProfile, parseProfile, serializeProfile } from './bindings';

export const BINDINGS_STORAGE_KEY = 'flightsim.bindings.v1';

/** Minimal `Storage` subset (so tests can pass a fake). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What is persisted: the customised keyboard profile and per-device gamepad profiles. */
export interface StoredBindings {
  version: 1;
  /** absent = built-in default keyboard set */
  keyboard?: BindingProfile;
  /** keyed by device key ('standard', 'hid:046d:c215', …) */
  gamepads: Record<string, BindingProfile>;
}

export const emptyStoredBindings = (): StoredBindings => ({ version: 1, gamepads: {} });

/** The browser's localStorage, or null when unavailable / blocked. */
export function browserStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** Loads stored bindings; returns empty state on any problem (errors are appended to `errors`). */
export function loadBindings(storage: StorageLike | null, errors: string[] = []): StoredBindings {
  const state = emptyStoredBindings();
  if (!storage) return state;
  let text: string | null = null;
  try { text = storage.getItem(BINDINGS_STORAGE_KEY); } catch (e) { errors.push(`storage read failed: ${(e as Error).message}`); return state; }
  if (!text) return state;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { errors.push('stored bindings are not valid JSON'); return state; }
  if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== 1) {
    errors.push('stored bindings have an unknown version');
    return state;
  }
  const r = raw as { keyboard?: unknown; gamepads?: unknown };
  if (r.keyboard !== undefined) {
    const p = parseProfile(r.keyboard);
    errors.push(...p.errors);
    if (p.profile) state.keyboard = { ...p.profile, device: 'keyboard' };
  }
  if (typeof r.gamepads === 'object' && r.gamepads !== null) {
    for (const [k, v] of Object.entries(r.gamepads as Record<string, unknown>)) {
      const p = parseProfile(v);
      errors.push(...p.errors);
      if (p.profile) state.gamepads[k] = { ...p.profile, device: 'gamepad' };
    }
  }
  return state;
}

/** Saves the state; returns false if storage is unavailable or throws (quota, private mode). */
export function saveBindings(storage: StorageLike | null, state: StoredBindings): boolean {
  if (!storage) return false;
  try {
    const gamepads: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(state.gamepads)) gamepads[k] = JSON.parse(serializeProfile(p));
    const doc: Record<string, unknown> = { version: 1, gamepads };
    if (state.keyboard) doc.keyboard = JSON.parse(serializeProfile(state.keyboard));
    storage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(doc));
    return true;
  } catch {
    return false;
  }
}

/** Removes all stored bindings (reset to defaults). */
export function clearBindings(storage: StorageLike | null): void {
  if (!storage) return;
  try { storage.removeItem(BINDINGS_STORAGE_KEY); } catch { /* storage blocked: nothing to clear */ }
}
