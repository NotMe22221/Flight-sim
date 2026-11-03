/**
 * Compiles a gamepad profile into flat, allocation-free evaluation records for one pad,
 * applying the D-pad / hat mode override ("look" or "trim") on top of the profile.
 */
import { type BindableAction, LEVER_AXES, axisIndexOf, axisRange } from './actions';
import { type Binding, type BindingInput, isActionBinding } from './bindings';
import { type ResolvedPreset, hatBit } from './gamepadId';
import { type AxisShaping, makeShaping } from './shaping';

export type DpadMode = 'profile' | 'look' | 'trim';

/** Source kinds of a compiled axis binding. */
export const AxisSrc = { Stick: 0, Lever: 1, Button: 2, Hat: 3, Half: 4 } as const;
export type AxisSrc = (typeof AxisSrc)[keyof typeof AxisSrc];
/** Source kinds of a compiled action binding. */
export const ActionSrc = { Button: 0, Hat: 1, Half: 2 } as const;
export type ActionSrc = (typeof ActionSrc)[keyof typeof ActionSrc];

export interface CompiledAxis {
  /** SimAxis index */
  ai: number;
  kind: AxisSrc;
  /** gamepad axis or button index */
  src: number;
  /** direction for buttons / hats / halves (±1) */
  dir: number;
  /** hat bit (Hat) or axis half sign (Half) */
  mask: number;
  shaping: AxisShaping;
  invert: boolean;
  lo: number;
  hi: number;
  /** a button / hat / axis half on a lever axis: moves the lever at a rate (like keys), not to a position */
  rate: boolean;
}

export interface CompiledAction {
  action: BindableAction;
  kind: ActionSrc;
  src: number;
  /** modifier button that must be held, −1 for none */
  modifier: number;
  /** modifiers used by other bindings on the same button (shadow this plain binding) */
  shadows: number[];
  mask: number;
  /** physical state of the input at the last poll (edge detection) */
  raw: boolean;
  /** pressed into the tracker (the chord matched when the input went down) */
  down: boolean;
}

export interface CompiledPad {
  axes: CompiledAxis[];
  actions: CompiledAction[];
}

const DPAD_BUTTONS = [12, 13, 14, 15];

/** True when a binding reads the D-pad (standard pads) or the POV hat (joysticks). */
function isDpadInput(b: BindingInput, r: ResolvedPreset): boolean {
  if (b.device !== 'gamepad') return false;
  if (r.standard) return b.button !== undefined && DPAD_BUTTONS.includes(b.button);
  const l = r.layout;
  if (!l || b.button !== undefined) return false;
  if (l.hat !== null && b.axisIndex === l.hat) return true;
  return !!l.hatXY && (b.axisIndex === l.hatXY[0] || b.axisIndex === l.hatXY[1]) && b.axisDir !== undefined;
}

/** D-pad / hat bindings for a mode, matching the pad's layout. */
export function dpadBindings(mode: 'look' | 'trim', r: ResolvedPreset): Binding[] {
  const dirs = ['up', 'down', 'left', 'right'] as const;
  const trim: BindableAction[] = ['trimNoseDown', 'trimNoseUp', 'rudderTrimLeft', 'rudderTrimRight'];
  const look: Array<['lookPitch' | 'lookYaw', 1 | -1]> = [['lookPitch', 1], ['lookPitch', -1], ['lookYaw', -1], ['lookYaw', 1]];
  const inputs: BindingInput[] = [];
  if (r.standard) for (const b of DPAD_BUTTONS) inputs.push({ device: 'gamepad', button: b });
  else if (r.layout?.hat != null) for (const d of dirs) inputs.push({ device: 'gamepad', axisIndex: r.layout.hat, hat: d });
  else if (r.layout?.hatXY) {
    const [x, y] = r.layout.hatXY;
    inputs.push({ device: 'gamepad', axisIndex: y, axisDir: -1 }, { device: 'gamepad', axisIndex: y, axisDir: 1 },
      { device: 'gamepad', axisIndex: x, axisDir: -1 }, { device: 'gamepad', axisIndex: x, axisDir: 1 });
  }
  return inputs.map((inp, i) => (mode === 'trim' ? { ...inp, action: trim[i] } : { ...inp, axis: look[i][0], dir: look[i][1] }));
}

/** Applies the D-pad mode override to a profile's bindings. */
export function effectiveBindings(bindings: readonly Binding[], mode: DpadMode, r: ResolvedPreset): Binding[] {
  if (mode === 'profile') return bindings.filter((b) => b.device === 'gamepad');
  return [...bindings.filter((b) => b.device === 'gamepad' && !isDpadInput(b, r)), ...dpadBindings(mode, r)];
}

/** Default deadzone per source kind (§B5.5). */
function defaultDeadzone(kind: AxisSrc, standard: boolean): number {
  if (kind === AxisSrc.Button) return 0.02;
  return standard ? 0.12 : 0.04;
}

/** Compiles bindings for one pad. */
export function compilePad(bindings: readonly Binding[], mode: DpadMode, r: ResolvedPreset): CompiledPad {
  const eff = effectiveBindings(bindings, mode, r);
  const axes: CompiledAxis[] = [];
  const actions: CompiledAction[] = [];
  for (const b of eff) {
    if (isActionBinding(b)) {
      if (b.button !== undefined) {
        actions.push({ action: b.action, kind: ActionSrc.Button, src: b.button, modifier: b.modifierButton ?? -1, shadows: [], mask: 0, raw: false, down: false });
      } else if (b.axisIndex !== undefined && b.hat) {
        actions.push({ action: b.action, kind: ActionSrc.Hat, src: b.axisIndex, modifier: -1, shadows: [], mask: hatBit(b.hat), raw: false, down: false });
      } else if (b.axisIndex !== undefined && b.axisDir) {
        actions.push({ action: b.action, kind: ActionSrc.Half, src: b.axisIndex, modifier: -1, shadows: [], mask: b.axisDir, raw: false, down: false });
      }
      continue;
    }
    const [lo, hi] = axisRange(b.axis);
    let kind: AxisSrc, src: number, mask = 0;
    if (b.button !== undefined) { kind = AxisSrc.Button; src = b.button; }
    else if (b.axisIndex === undefined) continue;
    else if (b.hat) { kind = AxisSrc.Hat; src = b.axisIndex; mask = hatBit(b.hat); }
    else if (b.axisDir) { kind = AxisSrc.Half; src = b.axisIndex; mask = b.axisDir; }
    else { kind = b.unipolar ? AxisSrc.Lever : AxisSrc.Stick; src = b.axisIndex; }
    const shaping = makeShaping({
      deadzone: b.deadzone ?? (kind === AxisSrc.Lever ? 0.03 : defaultDeadzone(kind, r.standard)),
      saturation: b.saturation, curve: b.curve ?? 0, invert: kind === AxisSrc.Stick ? !!b.invert : false, gain: b.sensitivity ?? 1,
    });
    const rate = LEVER_AXES.has(b.axis) && kind !== AxisSrc.Stick && kind !== AxisSrc.Lever;
    axes.push({ ai: axisIndexOf(b.axis), kind, src, dir: b.dir ?? 1, mask, shaping, invert: !!b.invert, lo, hi, rate });
  }
  // a plain button binding is shadowed while a modifier variant of the same button is satisfied
  for (const a of actions) {
    if (a.kind !== ActionSrc.Button || a.modifier >= 0) continue;
    for (const o of actions) if (o !== a && o.kind === ActionSrc.Button && o.src === a.src && o.modifier >= 0) a.shadows.push(o.modifier);
  }
  return { axes, actions };
}
