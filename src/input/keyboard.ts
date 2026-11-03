/**
 * Keyboard source: tracks keys by `KeyboardEvent.code`, resolves chords (exact modifier
 * match, captured at key-down) to actions and keyboard-synthesised axes, and turns them into
 * edges / repeats / held levels via a HoldTracker. Never relies on OS key repeat.
 *
 * Rules:
 *  - preventDefault only for chords that are bound (browser shortcuts keep working);
 *  - events from input/textarea/select/contenteditable, with Meta held, or while captured are ignored;
 *  - window blur / document hidden / capture release every key (no stuck keys);
 *  - an axis key pressed with unbound modifiers falls back to its unmodified binding
 *    (Shift+↑ still pitches) unless that chord is bound to an action.
 */
import type { SimAxis } from '../core/types';
import { AXIS_COUNT, type BindableAction, LEVER_AXES, actionMeta, axisIndexOf } from './actions';
import { type AxisBinding, type Binding, isActionBinding } from './bindings';
import { type Chord, MODIFIER_CODES, chordToString } from './chord';
import { HoldTracker, KeyAxis, type KeyAxisTuning, BRAKE_KEY_TUNING, LOOK_KEY_TUNING, STICK_KEY_TUNING, type RepeatTuning } from './keyAxis';

interface ChordEntry { actions: BindableAction[]; axes: AxisBinding[] }

interface KeyState {
  code: string;
  down: boolean;
  /** down at some point since the last poll (taps shorter than a frame still count) */
  latched: boolean;
  /** press order, for "last pressed wins" on an axis */
  seq: number;
  actions: BindableAction[];
  axes: AxisBinding[];
}

/** Axes whose keys act as rates (not ramped virtual sticks). */
const RATE_AXES: readonly SimAxis[] = ['throttle', 'mixture', 'propeller', 'cameraZoom'];
const RATE_AXIS_INDEX = RATE_AXES.map(axisIndexOf);

/** Keys that browsers use with Ctrl (Ctrl+Shift) for tabs, reload, zoom, find, print, devtools … */
const CTRL_BROWSER_CODES: ReadonlySet<string> = new Set([
  'KeyR', 'KeyW', 'KeyT', 'KeyN', 'KeyQ', 'KeyL', 'KeyP', 'KeyF', 'KeyS', 'KeyD', 'KeyO', 'KeyU', 'KeyI', 'KeyJ', 'KeyC', 'KeyV', 'KeyX',
  'Tab', 'PageUp', 'PageDown', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'Numpad0',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
]);

/**
 * Browser-essential chords (Ctrl[+Shift]+R/W/T/Tab/=/−/0/1…9/I/J …). An axis key never falls back
 * to its plain binding for these, so they are not swallowed unless a profile binds them explicitly.
 */
export function isBrowserChord(c: Chord): boolean {
  return !!c.ctrl && !c.alt && CTRL_BROWSER_CODES.has(c.code);
}

/** `performance.now()` (the clock of `Event.timeStamp`), 0 where unavailable. */
const clockMs = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);

/** Returns true when the event target is a text-entry control that owns the keyboard. */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as (HTMLElement & { tagName?: unknown }) | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** Tuning for the ramped keyboard axis of each centring SimAxis. */
export function keyAxisTuningFor(axis: SimAxis): KeyAxisTuning {
  if (axis === 'brakeLeft' || axis === 'brakeRight') return { ...BRAKE_KEY_TUNING };
  if (axis === 'lookYaw' || axis === 'lookPitch') return { ...LOOK_KEY_TUNING };
  return { ...STICK_KEY_TUNING };
}

export class KeyboardSource {
  /** edges, repeats and held levels of keyboard actions */
  readonly tracker: HoldTracker<BindableAction>;
  /** ramped virtual sticks for centring axes, created on demand from the bindings */
  readonly axes = new Map<SimAxis, KeyAxis>();
  private axisList: Array<{ axis: SimAxis; ka: KeyAxis; lastActive: number }> = [];
  private chords = new Map<string, ChordEntry>();
  private keys = new Map<string, KeyState>();
  private keyList: KeyState[] = [];
  private seq = 0;
  private captured = false;
  private attached = false;
  private pressedSincePoll = false;
  /** per-poll held direction of non-ramped axes (levers, zoom), sampled before taps are cleared */
  private polledDirs = new Float64Array(AXIS_COUNT);
  private listenFn: ((chord: Chord) => boolean) | null = null;
  /** clock time the rebinding hook was set; key events created before it are not new presses */
  private listenSince = 0;
  /** the event being dispatched when the hook was set (e.g. the Enter that activated "rebind") */
  private listenSkip: unknown = null;

  /**
   * Rebinding hook: receives every fresh non-modifier chord pressed after it was set (OS repeats
   * and the key event that is being dispatched while it is set are ignored); return true to swallow it.
   */
  get listener(): ((chord: Chord) => boolean) | null { return this.listenFn; }
  set listener(fn: ((chord: Chord) => boolean) | null) {
    this.listenFn = fn;
    this.listenSince = fn ? clockMs() : 0;
    this.listenSkip = fn ? (this.win as { event?: unknown } | null)?.event ?? null : null;
  }

  constructor(private win: Window | null, private doc: Document | null, bindings: readonly Binding[], repeat: Partial<RepeatTuning> = {}) {
    this.tracker = new HoldTracker<BindableAction>((a) => actionMeta(a), repeat);
    this.setBindings(bindings);
  }

  /** Rebuilds the chord index from the keyboard bindings; releases every key first. */
  setBindings(bindings: readonly Binding[]): void {
    this.releaseAll();
    this.chords.clear();
    for (const b of bindings) {
      if (b.device !== 'keyboard' || !b.code) continue;
      const k = chordToString({ code: b.code, ctrl: b.ctrl, shift: b.shift, alt: b.alt });
      let e = this.chords.get(k);
      if (!e) { e = { actions: [], axes: [] }; this.chords.set(k, e); }
      if (isActionBinding(b)) { if (!e.actions.includes(b.action)) e.actions.push(b.action); } else {
        e.axes.push(b);
        if (!LEVER_AXES.has(b.axis) && b.axis !== 'cameraZoom' && !this.axes.has(b.axis)) {
          const ka = new KeyAxis(keyAxisTuningFor(b.axis));
          this.axes.set(b.axis, ka);
          this.axisList.push({ axis: b.axis, ka, lastActive: -Infinity });
        }
      }
    }
    for (const a of this.axisList) a.ka.sensitivity = 1;
    for (const b of bindings) {
      if (b.device === 'keyboard' && !isActionBinding(b) && b.sensitivity !== undefined) {
        const ka = this.axes.get(b.axis);
        if (ka) ka.sensitivity = b.sensitivity;
      }
    }
  }

  attach(): void {
    if (this.attached || !this.win) return;
    this.attached = true;
    this.win.addEventListener('keydown', this.onKeyDown);
    this.win.addEventListener('keyup', this.onKeyUp);
    this.win.addEventListener('blur', this.onBlur);
    this.doc?.addEventListener('visibilitychange', this.onVisibility);
    this.doc?.addEventListener('focusin', this.onFocusIn);
  }

  detach(): void {
    if (!this.attached || !this.win) return;
    this.attached = false;
    this.win.removeEventListener('keydown', this.onKeyDown);
    this.win.removeEventListener('keyup', this.onKeyUp);
    this.win.removeEventListener('blur', this.onBlur);
    this.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.doc?.removeEventListener('focusin', this.onFocusIn);
    this.releaseAll();
  }

  /** While captured (a menu owns the keyboard) keys are ignored; capturing releases all keys. */
  setCaptured(flag: boolean): void {
    if (flag && !this.captured) this.releaseAll();
    this.captured = flag;
  }

  get isCaptured(): boolean { return this.captured; }

  /** True if a chord (exact) is bound to anything. */
  isBound(c: Chord): boolean { return this.chords.has(chordToString(c)); }

  /** Releases every key and action; ramped axes return to centre on their own. */
  releaseAll(): void {
    for (let i = 0; i < this.keyList.length; i++) {
      const s = this.keyList[i];
      s.down = false; s.latched = false; s.actions.length = 0; s.axes.length = 0;
    }
    this.tracker.releaseAll();
    for (let i = 0; i < this.axisList.length; i++) this.axisList[i].ka.setDirection(0);
  }

  /** Whether a key with this code is physically down. */
  isDown(code: string): boolean { return this.keys.get(code)?.down ?? false; }

  /**
   * Direction (−1/0/+1) requested for an axis by held (or tapped-since-last-poll) keys;
   * the most recently pressed key wins when both directions are held.
   */
  direction(axis: SimAxis): number {
    let best = -1, dir = 0;
    for (let i = 0; i < this.keyList.length; i++) {
      const s = this.keyList[i];
      if (!(s.down || s.latched) || s.seq < best) continue;
      for (let j = 0; j < s.axes.length; j++) {
        const b = s.axes[j];
        if (b.axis === axis && b.dir) { best = s.seq; dir = b.dir; }
      }
    }
    return dir;
  }

  /**
   * Direction requested during the last poll interval for a non-ramped axis (throttle,
   * mixture, propeller, cameraZoom): keys bound to these act as rates. Includes sub-frame taps.
   */
  polledDirection(axis: SimAxis): number { return this.polledDirs[axisIndexOf(axis)]; }

  /** Ramped value of a centring keyboard axis (0 if none is bound). */
  value(axis: SimAxis): number { return this.axes.get(axis)?.value ?? 0; }

  /** Manager-clock time a key last drove (or the ramp still deflects) this axis. */
  lastActive(axis: SimAxis): number {
    for (let i = 0; i < this.axisList.length; i++) if (this.axisList[i].axis === axis) return this.axisList[i].lastActive;
    return -Infinity;
  }

  /**
   * Advances ramps and repeat timers. `emit` receives edges/repeats, `hold` every held action.
   * Returns true if a bound key was pressed since the previous poll (device activity).
   * Allocation-free.
   */
  poll(dt: number, now: number, emit: (a: BindableAction) => void, hold: (a: BindableAction) => void): boolean {
    for (let i = 0; i < this.axisList.length; i++) {
      const e = this.axisList[i];
      e.ka.setDirection(this.direction(e.axis));
      e.ka.step(dt);
      if (e.ka.direction !== 0 || e.ka.value !== 0) e.lastActive = now;
    }
    this.tracker.poll(dt, emit, hold);
    for (let i = 0; i < RATE_AXES.length; i++) this.polledDirs[RATE_AXIS_INDEX[i]] = this.direction(RATE_AXES[i]);
    for (let i = 0; i < this.keyList.length; i++) { const s = this.keyList[i]; s.latched = s.down; }
    const pressed = this.pressedSincePoll;
    this.pressedSincePoll = false;
    return pressed;
  }

  private keyState(code: string): KeyState {
    let s = this.keys.get(code);
    if (!s) {
      s = { code, down: false, latched: false, seq: 0, actions: [], axes: [] };
      this.keys.set(code, s);
      this.keyList.push(s);
    }
    return s;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey) {
      // Cmd/Win chords belong to the browser/OS; macOS also drops the keyups of keys released
      // while Cmd is down, so release everything now instead of leaving keys stuck
      if (e.code === 'MetaLeft' || e.code === 'MetaRight' || e.code === 'OSLeft' || e.code === 'OSRight') this.releaseAll();
      return;
    }
    const listen = this.listenFn;
    if (listen) {
      if (MODIFIER_CODES.has(e.code)) return;
      // not a new press: OS repeat, or the key event that started the capture is still being dispatched
      if (e.repeat || e === this.listenSkip || (e.timeStamp > 0 && e.timeStamp < this.listenSince)) return;
      if (listen({ code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey })) e.preventDefault();
      return;
    }
    if (this.captured || isEditableTarget(e.target)) return;
    if (MODIFIER_CODES.has(e.code)) return;
    const chord: Chord = { code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
    const chordKey = chordToString(chord);
    const prev = this.keys.get(e.code);
    if (e.repeat || prev?.down) {
      // OS auto-repeat (we generate our own repeats) or a key still held from before a rebind /
      // menu: never a fresh press. Only keep the browser from acting on bound keys.
      if ((prev?.down && (prev.actions.length > 0 || prev.axes.length > 0)) || this.chords.has(chordKey)) e.preventDefault();
      return;
    }
    let entry = this.chords.get(chordKey);
    let axes = entry?.axes;
    const actions = entry?.actions;
    if ((!actions || actions.length === 0) && (!axes || axes.length === 0) && (e.ctrlKey || e.shiftKey || e.altKey) && !isBrowserChord(chord)) {
      entry = this.chords.get(e.code); // axis fallback to the unmodified chord
      axes = entry?.axes;
    }
    const hasActions = !!actions && actions.length > 0;
    const hasAxes = !!axes && axes.length > 0;
    if (!hasActions && !hasAxes) return;
    e.preventDefault();
    const s = this.keyState(e.code);
    s.down = true; s.latched = true; s.seq = ++this.seq;
    s.actions.length = 0; s.axes.length = 0;
    if (actions) for (const a of actions) { s.actions.push(a); this.tracker.press(a); }
    if (axes) for (const b of axes) s.axes.push(b);
    this.pressedSincePoll = true;
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    const s = this.keys.get(e.code);
    if (!s || !s.down) return;
    s.down = false;
    for (let i = 0; i < s.actions.length; i++) this.tracker.release(s.actions[i]);
    s.actions.length = 0;
    // axis bindings stay latched until the next poll so sub-frame taps still move the ramp
    e.preventDefault();
  };

  private readonly onBlur = (): void => { this.releaseAll(); };

  private readonly onVisibility = (): void => {
    if (this.doc && this.doc.visibilityState === 'hidden') this.releaseAll();
  };

  /** Focus moving into a text field: its keyups may never reach us (or belong to the field). */
  private readonly onFocusIn = (e: Event): void => {
    if (isEditableTarget(e.target)) this.releaseAll();
  };
}
