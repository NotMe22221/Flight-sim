/**
 * Gamepad identification (§B5.2): parse `Gamepad.id` across browsers, decode POV hats
 * reported as an axis (§B5.3), and pick a preset (profile + axis layout + button names)
 * from a per-VID:PID table with generic fallbacks.
 */
import type { HatDirection } from './bindings';
import { JOYSTICK_LAYOUT_CHROMIUM, JOYSTICK_LAYOUT_LINUX, type JoystickLayout, type ProfileId } from './profiles';

export interface ParsedGamepadId {
  /** 4-digit lowercase hex, when the id carries it */
  vendor?: string;
  product?: string;
  /** product name without vendor/product decoration */
  name: string;
  /** an XInput device (Xbox-compatible, standard mapping) */
  xinput: boolean;
}

/**
 * Parses Chrome ("Name (STANDARD GAMEPAD Vendor: 046d Product: c216)"), Firefox
 * ("046d-c216-Name", "xinput") and Safari ("46d-c216-Name") id formats.
 */
export function parseGamepadId(id: string): ParsedGamepadId {
  const xinput = /^\s*xinput\s*$/i.test(id) || /\(xinput standard gamepad\)\s*$/i.test(id) || /xinput/i.test(id);
  const v = /vendor:?\s*([0-9a-f]{1,4})(?:[^0-9a-f]|$)/i.exec(id)?.[1];
  const p = /product:?\s*([0-9a-f]{1,4})(?:[^0-9a-f]|$)/i.exec(id)?.[1];
  const ff = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-\s*(.*?)\s*$/i.exec(id);
  const pad4 = (s?: string): string | undefined => s?.toLowerCase().padStart(4, '0');
  const name = (ff?.[3] ?? id.replace(/\s*\(.*\)\s*$/, '')).trim();
  return { vendor: pad4(v ?? ff?.[1]), product: pad4(p ?? ff?.[2]), name: name || id, xinput };
}

/** Hat direction bits returned by `decodeHat`. */
export const HAT_UP = 1, HAT_DOWN = 2, HAT_LEFT = 4, HAT_RIGHT = 8;

export const hatBit = (d: HatDirection): number =>
  d === 'up' ? HAT_UP : d === 'down' ? HAT_DOWN : d === 'left' ? HAT_LEFT : HAT_RIGHT;

/**
 * Decodes a POV hat reported as one axis (Chromium `DpadFromAxis` ranges): −1 = up, steps of
 * 2/7 clockwise, +1 = up-left; |v| > 1 (e.g. 1.2857, 3.2857) or exactly 0 (start-up) = centred.
 * Returns a bitmask of HAT_* (diagonals set two bits).
 */
export function decodeHat(v: number): number {
  if (!Number.isFinite(v) || v === 0 || Math.abs(v) > 1.0001) return 0;
  let m = 0;
  if (v < -0.7 || v >= 0.95) m |= HAT_UP;
  if (v >= -0.75 && v < -0.1) m |= HAT_RIGHT;
  if (v >= -0.2 && v < 0.45) m |= HAT_DOWN;
  if (v >= 0.4) m |= HAT_LEFT;
  return m;
}

export type Platform = 'windows' | 'mac' | 'linux' | 'android' | 'ios' | 'other';

/** Coarse platform from a user-agent string (axis order of HID devices depends on it). */
export function detectPlatform(userAgent: string): Platform {
  const ua = userAgent.toLowerCase();
  if (ua.includes('android')) return 'android';
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'mac';
  if (ua.includes('linux') || ua.includes('x11') || ua.includes('cros')) return 'linux';
  return 'other';
}

export interface GamepadPreset {
  id: string;
  name: string;
  kind: 'gamepad' | 'joystick';
  /** VID:PID pairs (lowercase 4-digit hex) */
  match: ReadonlyArray<readonly [string, string]>;
  /** built-in profile the preset starts from */
  profile: ProfileId;
  /** axis layout for joysticks (Chromium Windows/macOS order unless overridden for Linux) */
  layout?: Readonly<JoystickLayout>;
  /** button names for labels (standard-mapping order) */
  buttonNames?: readonly string[];
}

const PS_BUTTONS = ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', 'D-Up', 'D-Down', 'D-Left', 'D-Right', 'PS'];

/** Known devices (research §B5.2). Joystick layouts follow Chromium's HID usage order. */
export const GAMEPAD_PRESETS: readonly GamepadPreset[] = [
  { id: 'xbox', name: 'Xbox controller', kind: 'gamepad', profile: 'gamepad-xbox',
    match: [['045e', '028e'], ['045e', '02d1'], ['045e', '02dd'], ['045e', '02ea'], ['045e', '0b12'], ['045e', '0b13'], ['045e', '0b20']] },
  { id: 'dualshock4', name: 'DualShock 4', kind: 'gamepad', profile: 'gamepad-xbox', buttonNames: PS_BUTTONS,
    match: [['054c', '05c4'], ['054c', '09cc'], ['054c', '0ba0']] },
  { id: 'dualsense', name: 'DualSense', kind: 'gamepad', profile: 'gamepad-xbox', buttonNames: PS_BUTTONS,
    match: [['054c', '0ce6'], ['054c', '0df2']] },
  { id: 'extreme-3d-pro', name: 'Logitech Extreme 3D Pro', kind: 'joystick', profile: 'joystick-generic',
    match: [['046d', 'c215']], layout: JOYSTICK_LAYOUT_CHROMIUM },
  { id: 't16000m', name: 'Thrustmaster T.16000M', kind: 'joystick', profile: 'joystick-generic',
    match: [['044f', 'b10a']], layout: JOYSTICK_LAYOUT_CHROMIUM },
  { id: 'tflight-hotas-x', name: 'Thrustmaster T.Flight HOTAS X', kind: 'joystick', profile: 'joystick-generic',
    match: [['044f', 'b108']], layout: JOYSTICK_LAYOUT_CHROMIUM },
];

export const GENERIC_GAMEPAD: GamepadPreset = { id: 'generic-gamepad', name: 'Gamepad', kind: 'gamepad', profile: 'gamepad-xbox', match: [] };
export const GENERIC_JOYSTICK: GamepadPreset = {
  id: 'generic-joystick', name: 'Joystick', kind: 'joystick', profile: 'joystick-generic', match: [], layout: JOYSTICK_LAYOUT_CHROMIUM,
};

export interface ResolvedPreset {
  preset: GamepadPreset;
  parsed: ParsedGamepadId;
  /** buttons follow the W3C standard layout */
  standard: boolean;
  /** persistence key: 'standard' for standard-mapping pads, 'hid:vvvv:pppp' (or 'id:<name>') otherwise */
  deviceKey: string;
  /** effective joystick layout (Linux override applied) */
  layout: Readonly<JoystickLayout> | null;
}

/** Chooses the preset for a pad from its id, mapping and the platform. */
export function resolvePreset(id: string, mapping: string, platform: Platform = 'other'): ResolvedPreset {
  const parsed = parseGamepadId(id);
  const standard = mapping === 'standard' || parsed.xinput;
  const known = parsed.vendor && parsed.product
    ? GAMEPAD_PRESETS.find((p) => p.match.some(([v, pid]) => v === parsed.vendor && pid === parsed.product))
    : undefined;
  const preset = known ?? (standard ? GENERIC_GAMEPAD : GENERIC_JOYSTICK);
  const deviceKey = standard ? 'standard'
    : parsed.vendor && parsed.product ? `hid:${parsed.vendor}:${parsed.product}` : `id:${parsed.name}`;
  let layout: Readonly<JoystickLayout> | null = null;
  if (preset.kind === 'joystick' && !standard) layout = platform === 'linux' ? JOYSTICK_LAYOUT_LINUX : (preset.layout ?? JOYSTICK_LAYOUT_CHROMIUM);
  return { preset, parsed, standard, deviceKey, layout };
}
