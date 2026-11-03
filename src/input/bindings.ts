/**
 * Binding model: a binding connects one physical input (key chord, mouse button/wheel,
 * gamepad button/axis/hat) to an action or an axis. Profiles are plain JSON-serialisable
 * data; this file holds the model, trigger identity, conflict detection, merge/override,
 * rebinding and (de)serialisation. Default profiles live in `profiles.ts`.
 */
import type { SimAxis } from '../core/types';
import { type BindableAction, isBindableAction, isSimAxis } from './actions';
import { chordLabel, chordToString, gamepadAxisLabel, gamepadButtonLabel, mouseButtonLabel } from './chord';

export type InputDevice = 'keyboard' | 'mouse' | 'gamepad';
export type HatDirection = 'up' | 'down' | 'left' | 'right';

/** Fields identifying the physical input. Which ones apply depends on `device`. */
export interface BindingInput {
  device: InputDevice;
  /** keyboard: `KeyboardEvent.code` */
  code?: string;
  /** keyboard / mouse modifiers (exact match) */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** mouse: `MouseEvent.button`; gamepad: button index */
  button?: number;
  /** gamepad: another button that must be held (shift layer) */
  modifierButton?: number;
  /** gamepad: axis index (stick, slider, or a POV hat reported as an axis) */
  axisIndex?: number;
  /** gamepad: hat direction decoded from `axisIndex` */
  hat?: HatDirection;
  /** gamepad: use one half of `axisIndex` as a button (|value| > 0.5 in this direction) */
  axisDir?: 1 | -1;
  /** mouse: the wheel */
  wheel?: boolean;
}

/** Input → discrete action. */
export interface ActionBinding extends BindingInput {
  action: BindableAction;
}

/** Input → continuous axis. */
export interface AxisBinding extends BindingInput {
  axis: SimAxis;
  /** keys, buttons, hat directions, wheel: the direction this input pushes the axis */
  dir?: 1 | -1;
  /** gamepad axis: lever mapping 0..1 (throttle sliders) instead of −1..1 */
  unipolar?: boolean;
  invert?: boolean;
  /** 0..0.5, default per device (sticks 0.12, joysticks 0.04, triggers 0.02) */
  deadzone?: number;
  /** 0.5..1 (default 0.98) */
  saturation?: number;
  /** 0 = linear .. 1 = cubic */
  curve?: number;
  /** multiplier, default 1: output gain for analog axes, ramp rate for keys, step for the wheel */
  sensitivity?: number;
}

export type Binding = ActionBinding | AxisBinding;

export interface BindingProfile {
  version: 1;
  /** 'msfs' | 'laptop' | 'default' | 'gamepad-xbox' | 'joystick-generic' | custom */
  id: string;
  name: string;
  /** keyboard profiles also carry mouse bindings */
  device: 'keyboard' | 'gamepad';
  bindings: Binding[];
}

export const isActionBinding = (b: Binding): b is ActionBinding => 'action' in b;
export const isAxisBinding = (b: Binding): b is AxisBinding => 'axis' in b;

/**
 * Canonical identity of the physical input of a binding, e.g. `k:Ctrl+KeyE`, `m:b1`,
 * `m:wheel`, `g:b6`, `g:b0+b4` (button 0 while 4 held), `g:a9:up` (hat), `g:a1` (full axis),
 * `g:a1:+` (half axis as a button).
 */
export function triggerKey(b: BindingInput): string {
  switch (b.device) {
    case 'keyboard': return `k:${chordToString({ code: b.code ?? '', ctrl: b.ctrl, shift: b.shift, alt: b.alt })}`;
    case 'mouse': {
      const mods = `${b.ctrl ? 'Ctrl+' : ''}${b.shift ? 'Shift+' : ''}${b.alt ? 'Alt+' : ''}`;
      return b.wheel ? `m:${mods}wheel` : `m:${mods}b${b.button ?? 0}`;
    }
    case 'gamepad': {
      if (b.button !== undefined) return `g:b${b.button}${b.modifierButton !== undefined ? `+b${b.modifierButton}` : ''}`;
      const a = `g:a${b.axisIndex ?? 0}`;
      if (b.hat) return `${a}:${b.hat}`;
      if (b.axisDir) return `${a}:${b.axisDir > 0 ? '+' : '-'}`;
      return a;
    }
  }
}

/** What a binding drives: `action:flapsDown`, `axis:pitch:-1`, `axis:throttle`. */
export function targetKey(b: Binding): string {
  if (isActionBinding(b)) return `action:${b.action}`;
  return b.dir ? `axis:${b.axis}:${b.dir}` : `axis:${b.axis}`;
}

/** True when two bindings are triggered by the same (or overlapping) physical input. */
export function triggersOverlap(a: BindingInput, b: BindingInput): boolean {
  const ka = triggerKey(a), kb = triggerKey(b);
  if (ka === kb) return true;
  // a full gamepad axis overlaps its halves and hat directions
  if (a.device === 'gamepad' && b.device === 'gamepad' && a.button === undefined && b.button === undefined && a.axisIndex === b.axisIndex) {
    const aFull = !a.hat && !a.axisDir, bFull = !b.hat && !b.axisDir;
    return aFull || bFull;
  }
  return false;
}

export interface BindingConflict {
  /** label of the shared input, e.g. "Ctrl+E" */
  label: string;
  a: Binding;
  b: Binding;
}

/**
 * Finds pairs of bindings sharing a physical input but driving different targets.
 * Identical duplicates are not conflicts. Two directions of one axis on one input are.
 */
export function findConflicts(bindings: readonly Binding[]): BindingConflict[] {
  const out: BindingConflict[] = [];
  for (let i = 0; i < bindings.length; i++) {
    for (let j = i + 1; j < bindings.length; j++) {
      const a = bindings[i], b = bindings[j];
      if (!triggersOverlap(a, b) || targetKey(a) === targetKey(b)) continue;
      out.push({ label: bindingLabel(a), a, b });
    }
  }
  return out;
}

/**
 * Merges profiles in order; a later binding replaces earlier ones on an overlapping
 * input (override), identical duplicates collapse. Order of first appearance is kept.
 */
export function mergeProfiles(id: string, name: string, ...profiles: readonly BindingProfile[]): BindingProfile {
  const merged: Binding[] = [];
  for (const p of profiles) {
    for (const b of p.bindings) {
      const dup = merged.findIndex((m) => triggerKey(m) === triggerKey(b) && targetKey(m) === targetKey(b));
      if (dup >= 0) continue;
      for (let i = merged.length - 1; i >= 0; i--) if (triggersOverlap(merged[i], b)) merged.splice(i, 1);
      merged.push(cloneBinding(b));
    }
  }
  return { version: 1, id, name, device: profiles[0]?.device ?? 'keyboard', bindings: merged };
}

/** Result of `rebind`. */
export interface RebindOutcome {
  profile: BindingProfile;
  /** other bindings that used the same input and were removed */
  displaced: Binding[];
  /** bindings of the same target on the same device that were replaced */
  replaced: Binding[];
}

/**
 * Binds `binding` in a copy of `profile`: existing bindings of the same target on the same
 * device are replaced (one input per action per device, like a primary slot), and any
 * binding using the same input for something else is displaced (reported for "swap" UIs).
 */
export function rebind(profile: BindingProfile, binding: Binding): RebindOutcome {
  const target = targetKey(binding);
  const displaced: Binding[] = [];
  const replaced: Binding[] = [];
  const kept: Binding[] = [];
  for (const b of profile.bindings) {
    if (targetKey(b) === target && b.device === binding.device) replaced.push(b);
    else if (triggersOverlap(b, binding)) displaced.push(b);
    else kept.push(b);
  }
  kept.push(cloneBinding(binding));
  return { profile: { ...profile, bindings: kept }, displaced, replaced };
}

/** Removes every binding of a target on a device. */
export function unbind(profile: BindingProfile, target: Binding | string, device?: InputDevice): BindingProfile {
  const key = typeof target === 'string' ? target : targetKey(target);
  return { ...profile, bindings: profile.bindings.filter((b) => !(targetKey(b) === key && (!device || b.device === device))) };
}

export function cloneBinding<B extends Binding>(b: B): B { return { ...b }; }
export function cloneProfile(p: BindingProfile): BindingProfile {
  return { ...p, bindings: p.bindings.map(cloneBinding) };
}

/**
 * Short label for a binding's input: "Ctrl+E", "Num 7", "Mouse Middle", "Pad A",
 * "Joy 3", "Pad LS Y", "Joy Hat up". `standardPad` selects Xbox names for gamepads.
 */
export function bindingLabel(b: BindingInput, standardPad = true): string {
  switch (b.device) {
    case 'keyboard': return chordLabel({ code: b.code ?? '?', ctrl: b.ctrl, shift: b.shift, alt: b.alt });
    case 'mouse': {
      const mods = `${b.ctrl ? 'Ctrl+' : ''}${b.shift ? 'Shift+' : ''}${b.alt ? 'Alt+' : ''}`;
      return mods + (b.wheel ? 'Mouse Wheel' : mouseButtonLabel(b.button ?? 0));
    }
    case 'gamepad': {
      if (b.button !== undefined) {
        const main = gamepadButtonLabel(b.button, standardPad);
        if (b.modifierButton === undefined) return main;
        return `${gamepadButtonLabel(b.modifierButton, standardPad)}+${main.replace(/^(Pad|Joy) /, '')}`;
      }
      const prefix = standardPad ? 'Pad' : 'Joy';
      if (b.hat) return `${prefix} Hat ${b.hat}`;
      const axis = gamepadAxisLabel(b.axisIndex ?? 0, standardPad);
      return b.axisDir ? `${axis}${b.axisDir > 0 ? '+' : '−'}` : axis;
    }
  }
}

// ───────────────────────────────── JSON (de)serialisation ─────────────────────────────────

const BINDING_FIELDS = [
  'action', 'axis', 'device', 'code', 'ctrl', 'shift', 'alt', 'button', 'modifierButton', 'axisIndex', 'hat',
  'axisDir', 'wheel', 'dir', 'unipolar', 'invert', 'deadzone', 'saturation', 'curve', 'sensitivity',
] as const;

/** Stable JSON for a profile (field order fixed, undefined fields dropped). */
export function serializeProfile(p: BindingProfile): string {
  const bindings = p.bindings.map((b) => {
    const o: Record<string, unknown> = {};
    const src = b as unknown as Record<string, unknown>;
    for (const f of BINDING_FIELDS) if (src[f] !== undefined && src[f] !== false) o[f] = src[f];
    return o;
  });
  return JSON.stringify({ version: 1, id: p.id, name: p.name, device: p.device, bindings });
}

export interface ParseResult {
  /** null when the document itself is unusable */
  profile: BindingProfile | null;
  /** one message per rejected binding / field */
  errors: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 64;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates one raw binding object; returns null (and pushes an error) if invalid. */
export function parseBinding(raw: unknown, errors: string[], where = 'binding'): Binding | null {
  if (!isObj(raw)) { errors.push(`${where}: not an object`); return null; }
  const device = raw.device;
  if (device !== 'keyboard' && device !== 'mouse' && device !== 'gamepad') { errors.push(`${where}: bad device`); return null; }
  const input: BindingInput = { device };
  if (device === 'keyboard') {
    if (typeof raw.code !== 'string' || raw.code.length === 0) { errors.push(`${where}: keyboard binding needs a code`); return null; }
    input.code = raw.code;
  } else if (device === 'mouse') {
    if (raw.wheel === true) input.wheel = true;
    else if (isInt(raw.button)) input.button = raw.button;
    else { errors.push(`${where}: mouse binding needs a button or the wheel`); return null; }
  } else {
    if (isInt(raw.button)) {
      input.button = raw.button;
      if (isInt(raw.modifierButton)) input.modifierButton = raw.modifierButton;
    } else if (isInt(raw.axisIndex)) {
      input.axisIndex = raw.axisIndex;
      if (raw.hat === 'up' || raw.hat === 'down' || raw.hat === 'left' || raw.hat === 'right') input.hat = raw.hat;
      else if (raw.axisDir === 1 || raw.axisDir === -1) input.axisDir = raw.axisDir;
    } else { errors.push(`${where}: gamepad binding needs a button or an axisIndex`); return null; }
  }
  if (device !== 'gamepad') {
    if (raw.ctrl === true) input.ctrl = true;
    if (raw.shift === true) input.shift = true;
    if (raw.alt === true) input.alt = true;
  }
  if (typeof raw.action === 'string') {
    if (!isBindableAction(raw.action)) { errors.push(`${where}: unknown action "${raw.action}"`); return null; }
    return { ...input, action: raw.action };
  }
  if (typeof raw.axis === 'string') {
    if (!isSimAxis(raw.axis)) { errors.push(`${where}: unknown axis "${raw.axis}"`); return null; }
    const b: AxisBinding = { ...input, axis: raw.axis };
    if (raw.dir === 1 || raw.dir === -1) b.dir = raw.dir;
    if (raw.unipolar === true) b.unipolar = true;
    if (raw.invert === true) b.invert = true;
    if (isNum(raw.deadzone)) b.deadzone = Math.min(0.5, Math.max(0, raw.deadzone));
    if (isNum(raw.saturation)) b.saturation = Math.min(1, Math.max(0.5, raw.saturation));
    if (isNum(raw.curve)) b.curve = Math.min(1, Math.max(0, raw.curve));
    if (isNum(raw.sensitivity)) b.sensitivity = Math.min(5, Math.max(0.1, raw.sensitivity));
    const needsDir = device !== 'gamepad' || input.button !== undefined || input.hat !== undefined || input.axisDir !== undefined;
    if (needsDir && b.dir === undefined && !(device === 'mouse' && input.wheel)) { errors.push(`${where}: axis key/button needs dir ±1`); return null; }
    return b;
  }
  errors.push(`${where}: needs an action or an axis`);
  return null;
}

/** Parses and validates a profile from JSON text or an already-parsed object. Invalid bindings are dropped and reported. */
export function parseProfile(input: string | unknown): ParseResult {
  const errors: string[] = [];
  let raw: unknown = input;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input); } catch (e) { return { profile: null, errors: [`invalid JSON: ${(e as Error).message}`] }; }
  }
  if (!isObj(raw)) return { profile: null, errors: ['profile is not an object'] };
  if (raw.version !== 1) return { profile: null, errors: [`unsupported version ${String(raw.version)}`] };
  if (typeof raw.id !== 'string' || !Array.isArray(raw.bindings)) return { profile: null, errors: ['profile needs id and bindings[]'] };
  const device = raw.device === 'gamepad' ? 'gamepad' : 'keyboard';
  const bindings: Binding[] = [];
  raw.bindings.forEach((rb, i) => { const b = parseBinding(rb, errors, `bindings[${i}]`); if (b) bindings.push(b); });
  return { profile: { version: 1, id: raw.id, name: typeof raw.name === 'string' ? raw.name : raw.id, device, bindings }, errors };
}
