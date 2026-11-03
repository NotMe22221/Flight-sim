/**
 * Input module public API: keyboard / mouse / gamepad / touch → InputSnapshot + ControlInputs,
 * with rebindable, persisted bindings. See README.md.
 */
export { InputManager } from './InputManager';
export type { InputManagerOptions, InputDeviceKind, DeviceChangeEvent, RebindResult, ListenOptions } from './InputManager';
export {
  SIM_ACTION_META, LOCAL_ACTION_META, SIM_ACTIONS, LOCAL_ACTIONS, SIM_AXES, LEVER_AXES,
  actionMeta, axisTitle, isSimAction, isLocalAction, isBindableAction, isSimAxis,
} from './actions';
export type { LocalAction, BindableAction, ActionGroup, ActionMeta, RepeatKind } from './actions';
export {
  bindingLabel, cloneProfile, findConflicts, isActionBinding, isAxisBinding, mergeProfiles, parseBinding, parseProfile,
  rebind, serializeProfile, targetKey, triggerKey, triggersOverlap, unbind,
} from './bindings';
export type {
  ActionBinding, AxisBinding, Binding, BindingConflict, BindingInput, BindingProfile, HatDirection, InputDevice, ParseResult, RebindOutcome,
} from './bindings';
export { BINDINGS_STORAGE_KEY, browserStorage, clearBindings, loadBindings, saveBindings } from './bindingStore';
export type { StorageLike, StoredBindings } from './bindingStore';
export { defaultProfile, joystickBindings, PROFILE_IDS, isProfileId, JOYSTICK_LAYOUT_CHROMIUM, JOYSTICK_LAYOUT_LINUX } from './profiles';
export type { ProfileId, JoystickLayout } from './profiles';
export { buildBindingRows, buildControlRows } from './bindingRows';
export type { BindingRow, ControlRow } from './bindingRows';
export { chordLabel, keyLabel, parseChord, chordToString } from './chord';
export type { Chord } from './chord';
export { DEFAULT_CONTROL_RATES, applyControlAction } from './controlsMapper';
export type { ControlRates } from './controlsMapper';
export { KeyAxis, HoldTracker, STICK_KEY_TUNING, DEFAULT_REPEAT } from './keyAxis';
export type { KeyAxisTuning, RepeatTuning } from './keyAxis';
export { DEFAULT_SHAPING, makeShaping, shapeAxis, shapeStick, shapingFromSensitivity, unipolarFromRaw, boxDeadzone } from './shaping';
export type { AxisShaping } from './shaping';
export { DEFAULT_MOUSE_OPTIONS } from './mouse';
export type { MouseOptions, MouseYokeMode, YokeIndicator } from './mouse';
export { DEFAULT_GAMEPAD_OPTIONS } from './gamepad';
export type { GamepadOptions, PadInfo } from './gamepad';
export type { DpadMode } from './gamepadCompile';
export { GAMEPAD_PRESETS, decodeHat, parseGamepadId, resolvePreset } from './gamepadId';
export type { GamepadPreset, ParsedGamepadId, ResolvedPreset } from './gamepadId';
export { DEFAULT_TOUCH_BUTTONS, stickFromDrag } from './touch';
export type { TouchOptions, TouchButtonSpec } from './touch';
export { BINDING_PROFILE_JSON_SCHEMA } from './profileSchema';
