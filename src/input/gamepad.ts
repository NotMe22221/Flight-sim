/**
 * Gamepad API source (§B5): polls `navigator.getGamepads()` every frame, resolves a preset per
 * pad (standard mapping / VID:PID table), shapes axes (deadzone, saturation, curve, unipolar
 * inverted throttle), edge-detects buttons / hats into actions with repeat, tracks per-axis
 * activity for arbitration, and offers optional rumble.
 */
import { AXIS_COUNT, type BindableAction, actionMeta } from './actions';
import type { BindingProfile, HatDirection } from './bindings';
import { ActionSrc, AxisSrc, type CompiledPad, type DpadMode, compilePad } from './gamepadCompile';
import { HAT_DOWN, HAT_LEFT, HAT_RIGHT, HAT_UP, type Platform, type ResolvedPreset, decodeHat, detectPlatform, resolvePreset } from './gamepadId';
import { HoldTracker } from './keyAxis';
import { shapeAxis, unipolarFromRaw } from './shaping';

export interface GamepadOptions {
  /** D-pad / hat: as the profile says, free-look, or trim */
  dpadMode: DpadMode;
  /** raw change that marks the pad as the active device (default 0.25) */
  activityThreshold: number;
  /** shaped change that marks "this pad moved this axis" for arbitration (default 0.02) */
  axisChangeThreshold: number;
  /** button value that counts as pressed (default 0.5) */
  pressThreshold: number;
}

export const DEFAULT_GAMEPAD_OPTIONS: Readonly<GamepadOptions> = { dpadMode: 'profile', activityThreshold: 0.25, axisChangeThreshold: 0.02, pressThreshold: 0.5 };

/** Public description of a connected pad. */
export interface PadInfo {
  index: number;
  id: string;
  name: string;
  presetId: string;
  kind: 'gamepad' | 'joystick';
  standard: boolean;
  deviceKey: string;
  profileId: string;
  /** Gamepad API rumble available */
  rumble: boolean;
}

/** A button press, axis movement or POV-hat direction seen while rebinding. */
export interface GamepadCapture { pad: PadInfo; button?: number; axisIndex?: number; axisDir?: 1 | -1; hat?: HatDirection }

interface Pad {
  info: PadInfo;
  resolved: ResolvedPreset;
  compiled: CompiledPad;
  gamepad: Gamepad | null;
  seen: boolean;
  primed: boolean;
  tracker: HoldTracker<BindableAction>;
  out: Float64Array;
  /** lever rate direction (−1..1) from buttons / hats bound to lever axes */
  rate: Float64Array;
  registered: Float64Array;
  lastChange: Float64Array;
  rawAxes: Float64Array;
  rawButtons: Uint8Array;
  /** rebinding: this pad's axis positions when the capture started (each pad has its own) */
  captureRest: Float64Array;
  captureArmed: boolean;
}

const MAX_AXES = 32, MAX_BUTTONS = 64;

export class GamepadSource {
  readonly options: GamepadOptions;
  private pads: Array<Pad | null> = [];
  private attached = false;
  private platform: Platform;
  /** aggregated per-axis value / last change across pads */
  private aggValue = new Float64Array(AXIS_COUNT);
  private aggChange = new Float64Array(AXIS_COUNT).fill(-Infinity);
  private aggRate = new Float64Array(AXIS_COUNT);
  /** index of the pad that showed activity most recently, −1 if none */
  activePad = -1;
  /** called on connect (true) / disconnect (false) */
  onConnection: ((pad: PadInfo, connected: boolean) => void) | null = null;
  /** rebinding hook; return true to consume the capture */
  listener: ((c: GamepadCapture) => boolean) | null = null;

  constructor(private win: Window | null, private nav: Navigator | null,
    private profileFor: (r: ResolvedPreset) => BindingProfile, options: Partial<GamepadOptions> = {}) {
    this.options = { ...DEFAULT_GAMEPAD_OPTIONS, ...options };
    this.platform = detectPlatform(nav?.userAgent ?? '');
  }

  attach(): void {
    if (this.attached || !this.win) return;
    this.attached = true;
    this.win.addEventListener('gamepadconnected', this.onConnected);
    this.win.addEventListener('gamepaddisconnected', this.onDisconnected);
  }

  detach(): void {
    if (!this.attached || !this.win) return;
    this.attached = false;
    this.win.removeEventListener('gamepadconnected', this.onConnected);
    this.win.removeEventListener('gamepaddisconnected', this.onDisconnected);
    for (const p of this.pads) p?.tracker.releaseAll();
  }

  /** Connected pads. */
  connected(): PadInfo[] { return this.pads.filter((p): p is Pad => !!p).map((p) => ({ ...p.info })); }

  /** Info for a pad index, or null. */
  padInfo(index: number): PadInfo | null { return this.pads[index]?.info ?? null; }

  /** Resolved preset (profile key, layout, labels) of a connected pad, or null. */
  resolved(index: number): ResolvedPreset | null { return this.pads[index]?.resolved ?? null; }

  /** Index of the active pad, else of the first connected one, else −1. */
  preferredPad(): number {
    if (this.activePad >= 0 && this.pads[this.activePad]) return this.activePad;
    return this.pads.findIndex((p) => !!p);
  }

  /** Recompiles every pad's bindings (after a profile change or a D-pad mode change). */
  refreshProfiles(): void {
    for (const p of this.pads) {
      if (!p) continue;
      p.tracker.releaseAll();
      const prof = this.profileFor(p.resolved);
      p.info.profileId = prof.id;
      p.compiled = compilePad(prof.bindings, this.options.dpadMode, p.resolved);
      this.primeActions(p);
    }
  }

  /**
   * Records which action inputs are already held, so a held button (e.g. the one just bound) fires
   * only when pressed again, and its release does not release another input's hold.
   */
  private primeActions(p: Pad): void {
    const gp = p.gamepad;
    if (!gp) return;
    for (const a of p.compiled.actions) { a.raw = this.actionInput(gp, a.kind, a.src, a.mask); a.down = false; }
  }

  /** Physical state of an action's input (button, hat direction or axis half). */
  private actionInput(gp: Gamepad, kind: number, src: number, mask: number): boolean {
    if (kind === ActionSrc.Button) return this.pressed(gp, src);
    if (kind === ActionSrc.Hat) return (decodeHat(gp.axes[src] ?? 0) & mask) !== 0;
    return (gp.axes[src] ?? 0) * mask > 0.5;
  }

  /** Changes the D-pad mode and recompiles. */
  setDpadMode(mode: DpadMode): void { this.options.dpadMode = mode; this.refreshProfiles(); }

  /** Aggregated value of an axis (from the pad that moved it most recently). */
  value(ai: number): number { return this.aggValue[ai]; }
  /** Manager-clock time a pad last moved this axis. */
  lastChange(ai: number): number { return this.aggChange[ai]; }
  /** Rate direction (−1..1) requested for a lever axis by pad buttons / hats (incremental, like keys). */
  rate(ai: number): number { return this.aggRate[ai]; }

  /**
   * Polls all pads. Emits button actions (edges + repeats) and held levels. Returns the
   * index of a pad that showed activity this poll, or −1. Allocation-free apart from the
   * array the browser returns from getGamepads().
   */
  poll(dt: number, now: number, emit: (a: BindableAction) => void, hold: (a: BindableAction) => void): number {
    let list: ArrayLike<Gamepad | null> = [];
    try { list = this.nav?.getGamepads?.() ?? []; } catch { list = []; }
    for (let i = 0; i < this.pads.length; i++) { const p = this.pads[i]; if (p) p.seen = false; }
    for (let i = 0; i < list.length; i++) {
      const gp = list[i];
      if (!gp || gp.connected === false) continue;
      let pad = this.pads[gp.index];
      if (pad && pad.info.id !== gp.id) { this.disconnect(gp.index); pad = null; } // another device took the slot
      if (!pad) pad = this.connect(gp);
      pad.gamepad = gp;
      pad.seen = true;
    }
    let active = -1;
    for (let i = 0; i < this.pads.length; i++) {
      const p = this.pads[i];
      if (!p) continue;
      if (!p.seen) { this.disconnect(i); continue; }
      if (this.readPad(p, dt, now, emit, hold)) active = i;
    }
    this.aggregate();
    if (active >= 0) this.activePad = active;
    return active;
  }

  /** Plays a dual-rumble effect on a pad (default: the active one). Returns false if unsupported. */
  rumble(strong: number, weak: number, durationMs: number, padIndex = this.activePad): boolean {
    const act = this.pads[padIndex]?.gamepad?.vibrationActuator;
    if (!act || typeof act.playEffect !== 'function') return false;
    const c = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
    try {
      const r = act.playEffect('dual-rumble', { startDelay: 0, duration: Math.max(0, durationMs), weakMagnitude: c(weak), strongMagnitude: c(strong) });
      if (r && typeof r.catch === 'function') r.catch(() => undefined);
      return true;
    } catch { return false; }
  }

  private connect(gp: Gamepad): Pad {
    const resolved = resolvePreset(gp.id, gp.mapping, this.platform);
    const prof = this.profileFor(resolved);
    const pad: Pad = {
      info: {
        index: gp.index, id: gp.id, name: resolved.preset.id.startsWith('generic') ? resolved.parsed.name : resolved.preset.name,
        presetId: resolved.preset.id, kind: resolved.standard ? 'gamepad' : resolved.preset.kind, standard: resolved.standard,
        deviceKey: resolved.deviceKey, profileId: prof.id, rumble: typeof gp.vibrationActuator?.playEffect === 'function',
      },
      resolved, compiled: compilePad(prof.bindings, this.options.dpadMode, resolved), gamepad: gp, seen: true, primed: false,
      tracker: new HoldTracker<BindableAction>((a) => actionMeta(a)),
      out: new Float64Array(AXIS_COUNT), rate: new Float64Array(AXIS_COUNT), registered: new Float64Array(AXIS_COUNT), lastChange: new Float64Array(AXIS_COUNT).fill(-Infinity),
      rawAxes: new Float64Array(MAX_AXES), rawButtons: new Uint8Array(MAX_BUTTONS),
      captureRest: new Float64Array(MAX_AXES), captureArmed: false,
    };
    this.pads[gp.index] = pad;
    this.onConnection?.({ ...pad.info }, true);
    return pad;
  }

  private disconnect(index: number): void {
    const p = this.pads[index];
    if (!p) return;
    p.tracker.releaseAll();
    this.pads[index] = null;
    if (this.activePad === index) this.activePad = -1;
    this.onConnection?.({ ...p.info }, false);
  }

  private pressed(gp: Gamepad, b: number): boolean {
    const btn = gp.buttons[b];
    return !!btn && (btn.pressed || btn.value > this.options.pressThreshold);
  }

  /** Reads one pad; returns true on device activity. */
  private readPad(p: Pad, dt: number, now: number, emit: (a: BindableAction) => void, hold: (a: BindableAction) => void): boolean {
    const gp = p.gamepad;
    p.rate.fill(0);
    if (!gp) return false;
    const o = this.options;
    // device activity (active-device switching) — first reading only primes the reference
    let moved = false;
    const na = Math.min(gp.axes.length, MAX_AXES), nb = Math.min(gp.buttons.length, MAX_BUTTONS);
    for (let i = 0; i < na; i++) {
      const v = gp.axes[i];
      if (Math.abs(v - p.rawAxes[i]) > o.activityThreshold) { p.rawAxes[i] = v; if (p.primed) moved = true; }
    }
    let risingButton = -1;
    for (let i = 0; i < nb; i++) {
      const d = this.pressed(gp, i) ? 1 : 0;
      if (d !== p.rawButtons[i]) {
        p.rawButtons[i] = d;
        if (p.primed && d === 1) { moved = true; if (risingButton < 0) risingButton = i; }
      }
    }
    if (this.listener) { this.capture(p, gp, risingButton); p.primed = true; return moved; }
    // axes
    const out = p.out;
    out.fill(0);
    const axes = p.compiled.axes;
    for (let i = 0; i < axes.length; i++) {
      const c = axes[i];
      let v = 0;
      switch (c.kind) {
        case AxisSrc.Stick: v = shapeAxis(gp.axes[c.src] ?? 0, c.shaping); break;
        case AxisSrc.Lever: v = unipolarFromRaw(gp.axes[c.src] ?? 0, c.invert, c.shaping.deadzone); out[c.ai] = v; continue;
        case AxisSrc.Button: v = c.dir * shapeAxis(gp.buttons[c.src]?.value ?? 0, c.shaping); break;
        case AxisSrc.Hat: v = (decodeHat(gp.axes[c.src] ?? 0) & c.mask) !== 0 ? c.dir : 0; break;
        case AxisSrc.Half: v = (gp.axes[c.src] ?? 0) * c.mask > 0.5 ? c.dir : 0; break;
      }
      if (c.rate) p.rate[c.ai] += v; else out[c.ai] += v;
    }
    for (let i = 0; i < axes.length; i++) {
      const c = axes[i];
      const v = out[c.ai];
      out[c.ai] = v < c.lo ? c.lo : v > c.hi ? c.hi : v;
    }
    for (let ai = 0; ai < AXIS_COUNT; ai++) {
      if (!p.primed) { p.registered[ai] = out[ai]; continue; }
      if (Math.abs(out[ai] - p.registered[ai]) > o.axisChangeThreshold) { p.registered[ai] = out[ai]; p.lastChange[ai] = now; }
    }
    // actions: the chord is decided when the input goes down (a modifier must already be held, a
    // held modifier variant shadows the plain binding); later modifier changes do not matter
    const acts = p.compiled.actions;
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i];
      const on = this.actionInput(gp, a.kind, a.src, a.mask);
      if (on === a.raw) continue;
      a.raw = on;
      if (on) {
        let ok = a.modifier < 0 || this.pressed(gp, a.modifier);
        for (let k = 0; ok && k < a.shadows.length; k++) if (this.pressed(gp, a.shadows[k])) ok = false;
        if (ok) { a.down = true; p.tracker.press(a.action); }
      } else if (a.down) { a.down = false; p.tracker.release(a.action); }
    }
    p.tracker.poll(dt, emit, hold);
    p.primed = true;
    return moved;
  }

  /**
   * Rebinding capture: a new button press, a POV-hat direction, or an axis moved > 0.5 from this
   * pad's rest value (each pad is compared with its own position when the capture started).
   */
  private capture(p: Pad, gp: Gamepad, risingButton: number): void {
    const n = Math.min(gp.axes.length, MAX_AXES);
    const rest = p.captureRest;
    if (!p.captureArmed) {
      for (let i = 0; i < n; i++) rest[i] = gp.axes[i];
      p.captureArmed = true;
      return;
    }
    if (risingButton >= 0 && this.listener?.({ pad: { ...p.info }, button: risingButton })) return;
    const hatAxis = p.resolved.layout?.hat ?? -1;
    for (let i = 0; i < n; i++) {
      const v = gp.axes[i];
      if (i === hatAxis || Math.abs(rest[i]) > 1.0001) {
        // a POV hat reported as one axis (centred = out of range): bind one direction, never the axis
        const bits = decodeHat(v);
        const hat: HatDirection | null = bits === HAT_UP ? 'up' : bits === HAT_DOWN ? 'down' : bits === HAT_LEFT ? 'left' : bits === HAT_RIGHT ? 'right' : null;
        if (hat && bits !== decodeHat(rest[i]) && this.listener?.({ pad: { ...p.info }, axisIndex: i, hat })) return;
        continue;
      }
      const delta = v - rest[i];
      if (Math.abs(delta) > 0.5 && Math.abs(v) <= 1.0001) {
        if (this.listener?.({ pad: { ...p.info }, axisIndex: i, axisDir: delta > 0 ? 1 : -1 })) return;
      }
    }
  }

  /** Ends a rebinding capture (called by the manager when it stops listening). */
  stopCapture(): void {
    this.listener = null;
    for (const p of this.pads) if (p) p.captureArmed = false;
  }

  private aggregate(): void {
    for (let ai = 0; ai < AXIS_COUNT; ai++) {
      let best = -Infinity, val = 0, found = false;
      for (let i = 0; i < this.pads.length; i++) {
        const p = this.pads[i];
        if (!p) continue;
        if (!found || p.lastChange[ai] > best) { found = true; best = p.lastChange[ai]; val = p.out[ai]; }
      }
      this.aggValue[ai] = val;
      this.aggChange[ai] = best;
      let r = 0;
      for (let i = 0; i < this.pads.length; i++) { const p = this.pads[i]; if (p) r += p.rate[ai]; }
      this.aggRate[ai] = r < -1 ? -1 : r > 1 ? 1 : r;
    }
  }

  private readonly onConnected = (e: Event): void => {
    const gp = (e as GamepadEvent).gamepad;
    if (gp && !this.pads[gp.index]) this.connect(gp);
  };

  private readonly onDisconnected = (e: Event): void => {
    const gp = (e as GamepadEvent).gamepad;
    if (gp) this.disconnect(gp.index);
  };
}
