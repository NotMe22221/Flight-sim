/**
 * Owns the active binding profiles: one keyboard(+mouse) profile and one gamepad profile per
 * device key, layered as "stored user profile ?? built-in default", persisted through
 * bindingStore. Used by InputManager for setProfile / resetProfile / rebinding.
 */
import { type Binding, type BindingProfile, type RebindOutcome, cloneProfile, rebind } from './bindings';
import { type StorageLike, type StoredBindings, clearBindings, loadBindings, saveBindings } from './bindingStore';
import type { ResolvedPreset } from './gamepadId';
import { type ProfileId, defaultProfile, joystickBindings } from './profiles';

export type KeyboardProfileId = 'default' | 'msfs' | 'laptop';
/** Device key whose stored profile applies to every non-standard (HID) device without its own override. */
export const HID_WILDCARD = 'hid';
export const isKeyboardProfileId = (s: string): s is KeyboardProfileId => s === 'default' || s === 'msfs' || s === 'laptop';

export class ProfileManager {
  private stored: StoredBindings;
  private keyboardProfile: BindingProfile;
  /** problems found while loading stored bindings (bad JSON, unknown actions …) */
  readonly loadErrors: string[] = [];

  constructor(private storage: StorageLike | null, private fallbackKeyboard: KeyboardProfileId = 'default') {
    this.stored = loadBindings(storage, this.loadErrors);
    this.keyboardProfile = this.stored.keyboard ? cloneProfile(this.stored.keyboard) : defaultProfile(fallbackKeyboard);
  }

  /** The active keyboard + mouse profile (do not mutate; use setKeyboard / rebindKeyboard). */
  get keyboard(): BindingProfile { return this.keyboardProfile; }

  /** Built-in default for a resolved pad (joystick bindings follow its axis layout). */
  presetProfile(r: ResolvedPreset): BindingProfile {
    if (r.preset.profile === 'joystick-generic' && r.layout) {
      const p = defaultProfile('joystick-generic');
      return { ...p, bindings: joystickBindings(r.layout) };
    }
    return defaultProfile(r.preset.profile);
  }

  /**
   * Active profile for a pad: stored override for its device key, else (HID devices) the
   * 'hid' wildcard override, else the preset default.
   */
  gamepad(r: ResolvedPreset): BindingProfile {
    const s = this.stored.gamepads[r.deviceKey] ?? (r.standard ? undefined : this.stored.gamepads[HID_WILDCARD]);
    return s ? cloneProfile(s) : this.presetProfile(r);
  }

  /** Stored override for a device key, if any. */
  storedGamepad(deviceKey: string): BindingProfile | undefined { return this.stored.gamepads[deviceKey]; }

  /** Replaces the keyboard profile and persists it. */
  setKeyboard(p: BindingProfile): void {
    this.keyboardProfile = { ...cloneProfile(p), device: 'keyboard' };
    this.stored.keyboard = this.keyboardProfile;
    this.save();
  }

  /** Replaces the profile used by pads with this device key and persists it. */
  setGamepad(deviceKey: string, p: BindingProfile): void {
    this.stored.gamepads[deviceKey] = { ...cloneProfile(p), device: 'gamepad' };
    this.save();
  }

  /** Binds into the keyboard profile (replace + displace semantics, see `rebind`). */
  rebindKeyboard(b: Binding): RebindOutcome {
    const out = rebind(this.keyboardProfile, b);
    this.setKeyboard({ ...out.profile, id: 'custom', name: 'Custom keyboard' });
    return out;
  }

  /** Binds into a pad's profile. */
  rebindGamepad(r: ResolvedPreset, b: Binding): RebindOutcome {
    const out = rebind(this.gamepad(r), b);
    this.setGamepad(r.deviceKey, { ...out.profile, id: 'custom', name: `Custom ${r.preset.name}` });
    return out;
  }

  /**
   * Resets to built-in defaults. Keyboard ids select that layout ('default' = msfs + laptop);
   * 'gamepad-xbox' clears overrides of standard-mapping pads, 'joystick-generic' of HID devices;
   * no id clears everything (and the stored key).
   */
  reset(id?: ProfileId): void {
    if (id === undefined) {
      this.stored = { version: 1, gamepads: {} };
      this.keyboardProfile = defaultProfile(this.fallbackKeyboard);
      clearBindings(this.storage);
      return;
    }
    if (isKeyboardProfileId(id)) {
      this.keyboardProfile = defaultProfile(id);
      if (id === this.fallbackKeyboard) delete this.stored.keyboard; else this.stored.keyboard = this.keyboardProfile;
    } else {
      const standard = id === 'gamepad-xbox';
      for (const k of Object.keys(this.stored.gamepads)) if ((k === 'standard') === standard) delete this.stored.gamepads[k];
    }
    this.save();
  }

  private save(): void {
    if (!this.stored.keyboard && Object.keys(this.stored.gamepads).length === 0) { clearBindings(this.storage); return; }
    saveBindings(this.storage, this.stored);
  }
}
