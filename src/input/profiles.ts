/**
 * Default binding profiles:
 *  - 'msfs'             MSFS 2020 "Keyboard Transversal" defaults (research 06 §B2/§B7, 01 §15) incl. numpad
 *  - 'laptop'           numpad-free layer (arrows pitch/roll, Q/E rudder, [ ] trim, Period brakes, P pause …)
 *  - 'default'          msfs + laptop merged — the out-of-the-box keyboard set
 *  - 'gamepad-xbox'     W3C standard mapping, MSFS Xbox layout (§B5.1)
 *  - 'joystick-generic' HID stick: X/Y, twist rudder, inverted slider throttle, hat look (§B5.7)
 */
import type { SimAxis } from '../core/types';
import type { BindableAction } from './actions';
import { type ActionBinding, type AxisBinding, type Binding, type BindingProfile, type HatDirection, mergeProfiles } from './bindings';
import { parseChord } from './chord';

export type ProfileId = 'default' | 'msfs' | 'laptop' | 'gamepad-xbox' | 'joystick-generic';

const key = (chord: string, action: BindableAction): ActionBinding => ({ device: 'keyboard', ...parseChord(chord), action });
const keyAxis = (chord: string, axis: SimAxis, dir: 1 | -1): AxisBinding => ({ device: 'keyboard', ...parseChord(chord), axis, dir });
const btn = (button: number, action: BindableAction): ActionBinding => ({ device: 'gamepad', button, action });
const hat = (axisIndex: number, h: HatDirection, axis: SimAxis, dir: 1 | -1): AxisBinding => ({ device: 'gamepad', axisIndex, hat: h, axis, dir });

/** Mouse bindings shared by both keyboard layers (free-look drag itself is built in). */
const MOUSE: Binding[] = [
  { device: 'mouse', button: 1, action: 'cameraReset' },
  { device: 'mouse', wheel: true, axis: 'cameraZoom' },
];

const MSFS_BINDINGS: Binding[] = [
  // primary flight controls (keyboard-synthesised axes with ramps)
  keyAxis('Numpad8', 'pitch', -1), keyAxis('Numpad2', 'pitch', 1),
  keyAxis('Numpad4', 'roll', -1), keyAxis('Numpad6', 'roll', 1),
  keyAxis('Numpad0', 'yaw', -1), keyAxis('NumpadEnter', 'yaw', 1),
  key('Numpad5', 'centerControls'),
  // trim
  key('Numpad7', 'trimNoseDown'), key('Numpad1', 'trimNoseUp'),
  key('Ctrl+Numpad0', 'rudderTrimLeft'), key('Ctrl+NumpadEnter', 'rudderTrimRight'),
  key('Ctrl+Numpad4', 'aileronTrimLeft'), key('Ctrl+Numpad6', 'aileronTrimRight'),
  // throttle / propeller / mixture
  key('F1', 'throttleCut'), key('F2', 'throttleDec'), key('F3', 'throttleInc'), key('F4', 'throttleFull'),
  key('Ctrl+F1', 'propellerLow'), key('Ctrl+F2', 'propellerDec'), key('Ctrl+F3', 'propellerInc'), key('Ctrl+F4', 'propellerHigh'),
  key('Ctrl+Shift+F1', 'mixtureLean'), key('Ctrl+Shift+F2', 'mixtureDec'), key('Ctrl+Shift+F3', 'mixtureInc'), key('Ctrl+Shift+F4', 'mixtureRich'),
  // flaps, gear, spoilers, brakes
  key('F5', 'flapsRetract'), key('F6', 'flapsUp'), key('F7', 'flapsDown'), key('F8', 'flapsFull'),
  key('KeyG', 'gearToggle'),
  key('NumpadDivide', 'spoilersToggle'), key('Slash', 'spoilersToggle'),
  key('NumpadDecimal', 'brakesHold'), key('Ctrl+NumpadDecimal', 'parkingBrakeToggle'),
  keyAxis('NumpadMultiply', 'brakeLeft', 1), keyAxis('NumpadSubtract', 'brakeRight', 1),
  // engine
  key('Ctrl+KeyE', 'engineAutoStart'), key('Ctrl+Shift+KeyE', 'engineShutdown'),
  key('KeyM', 'magnetosNext'), key('Shift+KeyM', 'magnetosPrev'), key('Shift+Alt+KeyG', 'starter'),
  key('KeyH', 'carbHeat'), key('Shift+KeyH', 'pitotHeat'),
  // lights
  key('KeyL', 'lightsAll'), key('Ctrl+KeyL', 'lightsLanding'), key('Alt+KeyN', 'lightsNav'), key('Alt+KeyH', 'lightsBeacon'),
  key('KeyO', 'lightsStrobe'), key('Alt+KeyJ', 'lightsTaxi'), key('Ctrl+Shift+KeyL', 'lightsPanel'),
  // autopilot
  key('KeyZ', 'apToggle'), key('Ctrl+KeyH', 'apHdg'), key('Ctrl+KeyT', 'apAlt'), key('Ctrl+KeyN', 'apNav'),
  key('Ctrl+KeyA', 'apApr'), key('Ctrl+KeyV', 'apVs'), key('Alt+KeyR', 'apFlc'), key('Ctrl+KeyF', 'fdToggle'),
  key('Ctrl+PageUp', 'apAltInc'), key('Ctrl+PageDown', 'apAltDec'), key('Ctrl+Home', 'apVsInc'), key('Ctrl+End', 'apVsDec'),
  key('Ctrl+Insert', 'headingBugInc'), key('Ctrl+Delete', 'headingBugDec'),
  key('KeyB', 'altimeterStd'),
  // camera
  key('End', 'cameraNext'), key('Insert', 'cameraDrone'), key('Ctrl+Space', 'cameraReset'), key('KeyS', 'cameraChase'),
  // sim / UI
  key('Escape', 'toggleMenu'), key('Pause', 'pause'), key('KeyY', 'slewToggle'), key('ScrollLock', 'toggleAtc'),
  key('KeyR', 'timeNormal'), key('Ctrl+NumpadAdd', 'timeFaster'), key('Ctrl+NumpadSubtract', 'timeSlower'),
  key('Ctrl+Semicolon', 'resetFlight'),
  key('F11', 'toggleHud'), key('F12', 'screenshot'), key('Shift+KeyR', 'repairRefuel'),
  key('Alt+KeyM', 'mouseYokeToggle'),
  // ATC menu options 1..9, 0
  key('Digit1', 'atcOption1'), key('Digit2', 'atcOption2'), key('Digit3', 'atcOption3'), key('Digit4', 'atcOption4'),
  key('Digit5', 'atcOption5'), key('Digit6', 'atcOption6'), key('Digit7', 'atcOption7'), key('Digit8', 'atcOption8'),
  key('Digit9', 'atcOption9'), key('Digit0', 'atcOption0'),
  ...MOUSE,
];

const LAPTOP_BINDINGS: Binding[] = [
  keyAxis('ArrowUp', 'pitch', -1), keyAxis('ArrowDown', 'pitch', 1),
  keyAxis('ArrowLeft', 'roll', -1), keyAxis('ArrowRight', 'roll', 1),
  keyAxis('KeyQ', 'yaw', -1), keyAxis('KeyE', 'yaw', 1),
  key('BracketLeft', 'trimNoseDown'), key('BracketRight', 'trimNoseUp'),
  key('Ctrl+ArrowLeft', 'aileronTrimLeft'), key('Ctrl+ArrowRight', 'aileronTrimRight'),
  key('Shift+KeyQ', 'rudderTrimLeft'), key('Shift+KeyE', 'rudderTrimRight'),
  key('F1', 'throttleCut'), key('F2', 'throttleDec'), key('F3', 'throttleInc'), key('F4', 'throttleFull'),
  key('PageUp', 'throttleInc'), key('PageDown', 'throttleDec'),
  key('F5', 'flapsRetract'), key('F6', 'flapsUp'), key('F7', 'flapsDown'), key('F8', 'flapsFull'),
  key('KeyG', 'gearToggle'),
  key('Period', 'brakesHold'), key('Ctrl+Period', 'parkingBrakeToggle'),
  key('Ctrl+KeyE', 'engineAutoStart'), key('Ctrl+Shift+KeyE', 'engineShutdown'),
  key('KeyP', 'pause'), key('Escape', 'toggleMenu'),
  key('KeyC', 'cameraNext'), key('Ctrl+Space', 'cameraReset'),
  key('Equal', 'zoomIn'), key('Minus', 'zoomOut'),
  // browser-safe alternatives for Ctrl+T / Ctrl+N / Ctrl+PgUp/PgDn (reserved by browsers)
  key('Shift+KeyT', 'apAlt'), key('Shift+KeyN', 'apNav'),
  key('Shift+PageUp', 'apAltInc'), key('Shift+PageDown', 'apAltDec'),
  key('Shift+Period', 'headingBugInc'), key('Shift+Comma', 'headingBugDec'),
  key('Shift+Equal', 'timeFaster'), key('Shift+Minus', 'timeSlower'), // not Ctrl+=/−: browser zoom
  key('KeyV', 'toggleMap'), key('Shift+Slash', 'toggleHelp'), key('Backquote', 'toggleAtc'),
  key('Alt+KeyM', 'mouseYokeToggle'), key('KeyF', 'freeLookToggle'),
  ...MOUSE,
];

/** W3C standard mapping, MSFS Xbox layout (§B5.1). Stick back = +pitch (nose up), so no inversion on LS Y. */
const XBOX_BINDINGS: Binding[] = [
  { device: 'gamepad', axisIndex: 0, axis: 'roll', deadzone: 0.12, curve: 0.3 },
  { device: 'gamepad', axisIndex: 1, axis: 'pitch', deadzone: 0.12, curve: 0.3 },
  { device: 'gamepad', axisIndex: 2, axis: 'lookYaw', deadzone: 0.15 },
  { device: 'gamepad', axisIndex: 3, axis: 'lookPitch', deadzone: 0.15, invert: true },
  { device: 'gamepad', button: 6, axis: 'yaw', dir: -1, deadzone: 0.02 },
  { device: 'gamepad', button: 7, axis: 'yaw', dir: 1, deadzone: 0.02 },
  btn(0, 'throttleInc'), btn(1, 'throttleDec'), btn(2, 'brakesHold'), btn(3, 'gearToggle'),
  btn(4, 'flapsUp'), btn(5, 'flapsDown'), btn(8, 'cameraNext'), btn(9, 'toggleMenu'),
  btn(10, 'parkingBrakeToggle'), btn(11, 'cameraReset'),
  btn(12, 'trimNoseDown'), btn(13, 'trimNoseUp'), btn(14, 'rudderTrimLeft'), btn(15, 'rudderTrimRight'),
];

/** Axis indices for a HID stick on Chromium Windows/macOS (index = HID usage − 0x30, §B5.3). */
export interface JoystickLayout {
  roll: number; pitch: number; yaw: number; throttle: number;
  /** POV hat reported as one axis, or null when the hat comes as two ±1 axes */
  hat: number | null;
  /** two-axis hat (Linux joydev): [x, y] */
  hatXY: [number, number] | null;
}
export const JOYSTICK_LAYOUT_CHROMIUM: Readonly<JoystickLayout> = { roll: 0, pitch: 1, yaw: 5, throttle: 6, hat: 9, hatXY: null };
/** Linux joydev order (X, Y, Rz, Throttle, Hat0X, Hat0Y) — UNVERIFIED, see research §B5.3. */
export const JOYSTICK_LAYOUT_LINUX: Readonly<JoystickLayout> = { roll: 0, pitch: 1, yaw: 2, throttle: 3, hat: null, hatXY: [4, 5] };

/** Builds the generic joystick profile for an axis layout (§B5.7). */
export function joystickBindings(l: Readonly<JoystickLayout>): Binding[] {
  const out: Binding[] = [
    { device: 'gamepad', axisIndex: l.roll, axis: 'roll', deadzone: 0.04, curve: 0.25 },
    { device: 'gamepad', axisIndex: l.pitch, axis: 'pitch', deadzone: 0.04, curve: 0.25 },
    { device: 'gamepad', axisIndex: l.yaw, axis: 'yaw', deadzone: 0.06, curve: 0.4 },
    { device: 'gamepad', axisIndex: l.throttle, axis: 'throttle', unipolar: true, invert: true },
  ];
  if (l.hat !== null) {
    out.push(hat(l.hat, 'up', 'lookPitch', 1), hat(l.hat, 'down', 'lookPitch', -1),
      hat(l.hat, 'left', 'lookYaw', -1), hat(l.hat, 'right', 'lookYaw', 1));
  } else if (l.hatXY) {
    out.push(
      { device: 'gamepad', axisIndex: l.hatXY[1], axisDir: -1, axis: 'lookPitch', dir: 1 },
      { device: 'gamepad', axisIndex: l.hatXY[1], axisDir: 1, axis: 'lookPitch', dir: -1 },
      { device: 'gamepad', axisIndex: l.hatXY[0], axisDir: -1, axis: 'lookYaw', dir: -1 },
      { device: 'gamepad', axisIndex: l.hatXY[0], axisDir: 1, axis: 'lookYaw', dir: 1 },
    );
  }
  out.push(
    btn(0, 'brakesHold'), btn(1, 'cameraNext'), btn(2, 'flapsUp'), btn(3, 'flapsDown'), btn(4, 'gearToggle'),
    btn(5, 'parkingBrakeToggle'), btn(6, 'trimNoseDown'), btn(7, 'trimNoseUp'), btn(8, 'cameraReset'),
    btn(9, 'cameraCockpit'), btn(10, 'pause'), btn(11, 'toggleMenu'),
  );
  return out;
}

const profile = (id: string, name: string, device: 'keyboard' | 'gamepad', bindings: Binding[]): BindingProfile =>
  ({ version: 1, id, name, device, bindings });

/** Fresh copy of a built-in profile (callers may mutate it). */
export function defaultProfile(id: ProfileId): BindingProfile {
  switch (id) {
    case 'msfs': return profile('msfs', 'MSFS 2020 keyboard', 'keyboard', MSFS_BINDINGS.map((b) => ({ ...b })));
    case 'laptop': return profile('laptop', 'Laptop (no numpad)', 'keyboard', LAPTOP_BINDINGS.map((b) => ({ ...b })));
    case 'default': return mergeProfiles('default', 'MSFS + laptop', defaultProfile('msfs'), defaultProfile('laptop'));
    case 'gamepad-xbox': return profile('gamepad-xbox', 'Xbox / standard gamepad', 'gamepad', XBOX_BINDINGS.map((b) => ({ ...b })));
    case 'joystick-generic': return profile('joystick-generic', 'Generic joystick', 'gamepad', joystickBindings(JOYSTICK_LAYOUT_CHROMIUM));
  }
}

export const PROFILE_IDS: readonly ProfileId[] = ['default', 'msfs', 'laptop', 'gamepad-xbox', 'joystick-generic'];
export const isProfileId = (s: string): s is ProfileId => (PROFILE_IDS as readonly string[]).includes(s);
