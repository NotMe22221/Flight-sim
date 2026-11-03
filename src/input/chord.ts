/**
 * Keyboard chords (a `KeyboardEvent.code` plus Ctrl/Shift/Alt) and human-readable labels
 * for keys, mouse buttons and gamepad buttons/axes ("Ctrl+E", "Num 7", "Pad A").
 */

/** A physical key plus modifiers. `code` is `KeyboardEvent.code` (layout independent). */
export interface Chord {
  code: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** Codes that are modifiers themselves; they never trigger a binding on their own. */
export const MODIFIER_CODES: ReadonlySet<string> = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'CapsLock', 'NumLock', 'Fn', 'FnLock', 'AltGraph',
]);

/**
 * Parses "Ctrl+Shift+KeyE" / "Alt+Numpad0" / "F1" into a chord. Modifier names are
 * case-insensitive (Ctrl|Control, Shift, Alt|Option). Throws on an empty key code.
 */
export function parseChord(text: string): Chord {
  const parts = text.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
  // "NumpadAdd" never contains '+', so a trailing empty part only happens for malformed input.
  const code = parts.pop();
  if (!code) throw new Error(`parseChord: no key in "${text}"`);
  const chord: Chord = { code };
  for (const p of parts) {
    const k = p.toLowerCase();
    if (k === 'ctrl' || k === 'control') chord.ctrl = true;
    else if (k === 'shift') chord.shift = true;
    else if (k === 'alt' || k === 'option') chord.alt = true;
    else throw new Error(`parseChord: unknown modifier "${p}" in "${text}"`);
  }
  return chord;
}

/** Canonical chord string "Ctrl+Shift+Alt+Code" (used as a map key and in JSON). */
export function chordToString(c: Chord): string {
  return `${c.ctrl ? 'Ctrl+' : ''}${c.shift ? 'Shift+' : ''}${c.alt ? 'Alt+' : ''}${c.code}`;
}

/** Packs the modifier state into 0..7 (ctrl=1, shift=2, alt=4). */
export const modMask = (ctrl: boolean | undefined, shift: boolean | undefined, alt: boolean | undefined): number =>
  (ctrl ? 1 : 0) | (shift ? 2 : 0) | (alt ? 4 : 0);

const NAMED_KEYS: Record<string, string> = {
  Space: 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  PageUp: 'PgUp', PageDown: 'PgDn', Home: 'Home', End: 'End', Insert: 'Insert', Delete: 'Del',
  Pause: 'Pause', ScrollLock: 'Scroll Lock', PrintScreen: 'PrtScn', ContextMenu: 'Menu',
  Period: '.', Comma: ',', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Minus: '-', Equal: '=', Backquote: '`', Backslash: '\\', IntlBackslash: '\\',
  NumpadDecimal: 'Num Del', NumpadEnter: 'Num Enter', NumpadAdd: 'Num +', NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadEqual: 'Num =', NumpadComma: 'Num ,',
  ControlLeft: 'Ctrl', ControlRight: 'Ctrl', ShiftLeft: 'Shift', ShiftRight: 'Shift',
  AltLeft: 'Alt', AltRight: 'Alt', MetaLeft: 'Meta', MetaRight: 'Meta',
};

/** Label for a bare key code: "KeyE" → "E", "Digit1" → "1", "Numpad7" → "Num 7", "ArrowUp" → "↑". */
export function keyLabel(code: string): string {
  const named = NAMED_KEYS[code];
  if (named) return named;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`;
  return code; // F1..F24 and anything exotic read fine as-is
}

/** Label for a chord: "Ctrl+E", "Ctrl+Shift+F1", "Num 7". */
export function chordLabel(c: Chord): string {
  return `${c.ctrl ? 'Ctrl+' : ''}${c.shift ? 'Shift+' : ''}${c.alt ? 'Alt+' : ''}${keyLabel(c.code)}`;
}

const MOUSE_BUTTONS = ['Left', 'Middle', 'Right', 'Back', 'Forward'];

/** "Mouse Middle" etc. (`MouseEvent.button` numbering). */
export function mouseButtonLabel(button: number): string {
  return `Mouse ${MOUSE_BUTTONS[button] ?? `Button ${button + 1}`}`;
}

/** W3C standard-mapping button names (Xbox labels). */
export const STANDARD_BUTTON_NAMES: readonly string[] = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L3', 'R3',
  'D-Up', 'D-Down', 'D-Left', 'D-Right', 'Guide',
];
/** W3C standard-mapping axis names. */
export const STANDARD_AXIS_NAMES: readonly string[] = ['LS X', 'LS Y', 'RS X', 'RS Y'];

/**
 * Label for a gamepad button. Standard-mapping pads use Xbox names ("Pad A"); other HID
 * devices (joysticks) use 1-based numbers as printed on the hardware ("Joy 3").
 */
export function gamepadButtonLabel(button: number, standard: boolean): string {
  if (standard) return `Pad ${STANDARD_BUTTON_NAMES[button] ?? `B${button}`}`;
  return `Joy ${button + 1}`;
}

/** Label for a gamepad axis ("Pad LS X", "Joy Axis 6"). */
export function gamepadAxisLabel(axis: number, standard: boolean): string {
  if (standard) return `Pad ${STANDARD_AXIS_NAMES[axis] ?? `Axis ${axis}`}`;
  return `Joy Axis ${axis}`;
}
