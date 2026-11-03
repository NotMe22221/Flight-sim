/**
 * InputManager: merges keyboard, mouse, gamepads and touch into one allocation-free
 * `InputSnapshot` per frame and owns the pilot's `ControlInputs` (continuous axes with
 * ramps and per-axis "last mover wins" arbitration; discrete state from actions).
 * Actions the controls don't own (camera, pause, AP, time, ATC …) are only reported in
 * `snapshot.actions` for the simulator. See README.md.
 */
import type { ControlInputs, InputSnapshot, SimAction, SimAxis } from '../core/types';
import { defaultControlInputs } from '../core/types';
import { clamp } from '../core/math';
import { type BindableAction, LEVER_AXES, LOCAL_ACTION_META, SIM_ACTION_META, SIM_AXES, axisIndexOf, isSimAction } from './actions';
import { type Binding, type BindingConflict, type BindingProfile, findConflicts, targetKey } from './bindings';
import { type BindingRow, type ControlRow, type LabelSource, buildBindingRows, buildControlRows, labelsFor } from './bindingRows';
import { type StorageLike, browserStorage } from './bindingStore';
import { type ControlRates, DEFAULT_CONTROL_RATES, type LeverAxis, type MapperContext, applyControlAction, rampToward } from './controlsMapper';
import { GamepadSource, type GamepadOptions, type PadInfo } from './gamepad';
import type { DpadMode } from './gamepadCompile';
import { KeyboardSource } from './keyboard';
import type { RepeatTuning } from './keyAxis';
import { MouseSource, type MouseOptions, type YokeIndicator } from './mouse';
import { HID_WILDCARD, type KeyboardProfileId, ProfileManager, isKeyboardProfileId } from './profileManager';
import { type ProfileId, defaultProfile, isProfileId } from './profiles';
import { TouchControls, type TouchOptions } from './touch';
import { type Capture, type CaptureOptions, type CapturedInput, captureNextInput } from './rebinding';

export interface InputManagerOptions {
  /** defaults to the global window / document / navigator (null disables that part) */
  window?: Window | null;
  document?: Document | null;
  navigator?: Navigator | null;
  /** defaults to localStorage (guarded); null disables persistence */
  storage?: StorageLike | null;
  /** keyboard layout when nothing is stored (default 'default' = MSFS + laptop merged) */
  keyboardProfile?: KeyboardProfileId;
  /** flap detents of the current aircraft (default 4: C172 0/10/20/30°) */
  flapDetents?: number;
  /** initial pilot controls (default `defaultControlInputs()`) */
  controls?: ControlInputs;
  rates?: Partial<ControlRates>;
  repeat?: Partial<RepeatTuning>;
  mouse?: Partial<MouseOptions>;
  gamepad?: Partial<GamepadOptions>;
  touch?: Partial<TouchOptions>;
  /** seconds keyboard lever increments are ignored after an analog lever moved (default 2) */
  leverHoldoff?: number;
}

export type InputDeviceKind = 'keyboard' | 'mouse' | 'gamepad' | 'touch';

export interface DeviceChangeEvent {
  kind: 'connected' | 'disconnected' | 'active';
  device: InputDeviceKind;
  /** set for gamepad events */
  pad?: PadInfo;
}

/** Result of a rebinding capture (assignable to the UI's BindingInfo when A is a SimAction). */
export interface RebindResult<A extends BindableAction = BindableAction> {
  action: A;
  label: string;
  device: 'keyboard' | 'gamepad';
  group: string;
  binding: Binding;
  /** bindings that used the same input before and were removed */
  displaced: Binding[];
}

/** Options for startListening: `device` ('any') and `timeoutMs` (8000, 0 = never). */
export type ListenOptions = CaptureOptions;

/** Sources that can own an axis, in tie-break priority order. */
const SRC_GAMEPAD = 0, SRC_TOUCH = 1, SRC_MOUSE = 2, SRC_KEYS = 3;
const CENTRING_AXES: readonly SimAxis[] = ['pitch', 'roll', 'yaw', 'brakeLeft', 'brakeRight', 'lookYaw', 'lookPitch'];
const LEVERS: readonly LeverAxis[] = ['throttle', 'mixture', 'propeller'];
const UNCAPTURED_ACTIONS: ReadonlySet<BindableAction> = new Set<BindableAction>(['toggleMenu', 'pause']);

export class InputManager {
  /** The pilot's controls, owned and updated by the manager (others may read; discrete fields may be set by the sim). */
  readonly controls: ControlInputs;
  /** The snapshot returned by every poll (same object; `actions` and `held` are refilled). */
  readonly snapshot: InputSnapshot;
  readonly rates: ControlRates;
  private readonly profiles: ProfileManager;
  private readonly keyboard: KeyboardSource;
  private readonly mouse: MouseSource;
  private readonly pads: GamepadSource;
  private readonly touch: TouchControls;
  private readonly win: Window | null;
  private readonly doc: Document | null;
  private now = 0;
  private captured = false;
  private flapDetents: number;
  private readonly leverHoldoff: number;
  /** last time an analog device moved each lever (index = LEVERS order) */
  private leverDeviceTime = new Float64Array(3).fill(-Infinity);
  /** true when the lever follows the device (false after a keyboard override) */
  private leverFollowsDevice = [false, false, false];
  private brakeHold = 0;
  private brakesHeld = false;
  private starterHeld = false;
  private starterWasHeld = false;
  private zoomLevel = 0;
  private readonly look: [number, number] = [0, 0];
  private readonly reportQueue: SimAction[] = [];
  private activeDevice: InputDeviceKind = 'keyboard';
  private activePadIndex = -1;
  private listeners: Array<(e: DeviceChangeEvent) => void> = [];
  private capture: Capture | null = null;
  private readonly mapperCtx: MapperContext;
  private readonly emitFn = (a: BindableAction): void => this.dispatch(a, false);
  private readonly holdFn = (a: BindableAction): void => this.markHeld(a);
  private disposed = false;

  /**
   * @param target the canvas (or element) the mouse listens on; keyboard listens on `window`
   */
  constructor(target: HTMLElement, options: InputManagerOptions = {}) {
    const g = globalThis as { window?: Window; document?: Document; navigator?: Navigator };
    this.win = options.window !== undefined ? options.window : g.window ?? null;
    this.doc = options.document !== undefined ? options.document : g.document ?? null;
    const nav = options.navigator !== undefined ? options.navigator : g.navigator ?? null;
    const storage = options.storage !== undefined ? options.storage : browserStorage();
    this.controls = options.controls ?? defaultControlInputs();
    this.rates = { ...DEFAULT_CONTROL_RATES, ...options.rates };
    this.flapDetents = Math.max(1, Math.floor(options.flapDetents ?? 4));
    this.leverHoldoff = options.leverHoldoff ?? 2;
    this.profiles = new ProfileManager(storage, options.keyboardProfile ?? 'default');
    const axes = {} as Record<SimAxis, number>;
    for (const a of SIM_AXES) axes[a] = 0;
    this.snapshot = { axes, actions: [], held: new Set<SimAction>(), pointerDx: 0, pointerDy: 0, mouseYoke: false };
    this.mapperCtx = {
      flapDetents: this.flapDetents,
      rates: this.rates,
      leverFree: (axis) => this.now - this.leverDeviceTime[LEVERS.indexOf(axis)] >= this.leverHoldoff,
    };
    const kb = this.profiles.keyboard.bindings;
    this.keyboard = new KeyboardSource(this.win, this.doc, kb, options.repeat);
    this.mouse = new MouseSource(target, this.doc, kb, options.mouse);
    this.pads = new GamepadSource(this.win, nav, (r) => this.profiles.gamepad(r), options.gamepad);
    this.pads.onConnection = (pad, connected) => this.notify({ kind: connected ? 'connected' : 'disconnected', device: 'gamepad', pad });
    this.touch = new TouchControls(options.touch);
    this.keyboard.attach();
    this.mouse.attach();
    this.pads.attach();
  }

  // ───────────────────────────── simple state ─────────────────────────────

  /** Number of flap detents of the current aircraft; flapsIndex is clamped to 0..n−1. */
  setFlapDetents(n: number): void {
    this.flapDetents = Math.max(1, Math.floor(n));
    this.mapperCtx.flapDetents = this.flapDetents;
    this.controls.flapsIndex = clamp(this.controls.flapsIndex, 0, this.flapDetents - 1);
  }

  /** True while a menu owns the keyboard: keys are ignored, gamepad actions except menu/pause are dropped. */
  setCaptured(flag: boolean): void {
    this.captured = flag;
    this.keyboard.setCaptured(flag);
    if (flag) this.mouse.releaseAll();
  }

  get isCaptured(): boolean { return this.captured; }

  /** Mouse-yoke mode (also toggled by the 'mouseYokeToggle' action, Alt+M by default). */
  setMouseYoke(on: boolean): void { this.mouse.setYoke(on); this.snapshot.mouseYoke = on; }
  get mouseYoke(): boolean { return this.mouse.yokeEnabled; }
  /** Live mouse-yoke indicator for the HUD (crosshair, deadzone box). */
  get yokeIndicator(): Readonly<YokeIndicator> { return this.mouse.indicator; }

  /** Pointer-lock free-look (also toggled by 'freeLookToggle', F by default). */
  setFreeLook(on: boolean): void { this.mouse.setFreeLook(on); }

  /** D-pad / hat behaviour for gamepads: profile bindings, free-look, or trim. */
  setDpadMode(mode: DpadMode): void { this.pads.setDpadMode(mode); }

  /** Shows the touch overlay inside `container` (default: the document body). */
  enableTouch(container?: HTMLElement): void {
    const c = container ?? this.doc?.body;
    if (c) this.touch.enable(c);
  }

  disableTouch(): void { this.touch.disable(); }
  get touchEnabled(): boolean { return this.touch.enabled; }

  /** Rumble on the active gamepad (strong/weak 0..1). Returns false when unsupported. */
  rumble(strong: number, weak: number, durationMs: number): boolean { return this.pads.rumble(strong, weak, durationMs); }

  /** Connected gamepads. */
  get gamepads(): PadInfo[] { return this.pads.connected(); }

  /** Device that produced input most recently. */
  get lastActiveDevice(): InputDeviceKind { return this.activeDevice; }

  /** Subscribes to connect / disconnect / active-device changes. Returns an unsubscribe function. */
  onDeviceChange(cb: (e: DeviceChangeEvent) => void): () => void {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
  }

  private notify(e: DeviceChangeEvent): void {
    for (const l of this.listeners.slice()) {
      try { l(e); } catch (err) { console.error('[input] device listener threw', err); }
    }
  }

  // ───────────────────────────── actions ─────────────────────────────

  /**
   * Applies an action exactly like its key/button would (UI buttons use this): the pilot
   * controls change immediately and SimActions are reported in the next snapshot.
   */
  applyAction(action: BindableAction): void { this.dispatch(action, true); }

  /** Applies one action to the controls / local state and reports SimActions. */
  private dispatch(a: BindableAction, fromUi: boolean): void {
    if (this.disposed) return;
    if (!fromUi && this.captured && !UNCAPTURED_ACTIONS.has(a)) return;
    switch (a) {
      case 'mouseYokeToggle': this.setMouseYoke(!this.mouse.yokeEnabled); return;
      case 'freeLookToggle': this.mouse.setFreeLook(!this.mouse.freeLookLocked); return;
      case 'centerControls':
        this.keyboard.axes.get('roll')?.set(0);
        this.keyboard.axes.get('yaw')?.set(0);
        this.controls.roll = 0; this.controls.yaw = 0;
        return;
      case 'cameraReset': this.zoomLevel = 0; break;
      default: break;
    }
    applyControlAction(this.controls, a, this.mapperCtx);
    const li = leverOfAction(a);
    if (li >= 0 && this.mapperCtx.leverFree(LEVERS[li])) this.leverFollowsDevice[li] = false;
    if (isSimAction(a)) {
      if (fromUi) this.reportQueue.push(a);
      else this.snapshot.actions.push(a);
    }
  }

  private markHeld(a: BindableAction): void {
    if (this.captured && !UNCAPTURED_ACTIONS.has(a)) return;
    if (a === 'brakesHold') this.brakesHeld = true;
    else if (a === 'starter') this.starterHeld = true;
    if (isSimAction(a)) this.snapshot.held.add(a);
  }

  // ───────────────────────────── per-frame poll ─────────────────────────────

  /**
   * Samples every device and returns the (reused) snapshot: arbitrated axes, edge actions
   * since the previous poll, held actions, free-look pointer delta, mouse-yoke flag.
   * Also updates `controls`. Allocation-free in steady state. dt in seconds (clamped to 0.25).
   */
  poll(dt: number): InputSnapshot {
    const snap = this.snapshot;
    if (this.disposed) return snap;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    this.now += step;
    const now = this.now;
    snap.actions.length = 0;
    for (let i = 0; i < this.reportQueue.length; i++) snap.actions.push(this.reportQueue[i]);
    this.reportQueue.length = 0;
    snap.held.clear();
    this.brakesHeld = false;
    this.starterHeld = false;
    const kbActive = this.keyboard.poll(step, now, this.emitFn, this.holdFn);
    const wheel = this.mouse.poll(step, now, this.look, this.emitFn, this.holdFn);
    const mouseActive = this.mouse.consumeActivity();
    const padActive = this.pads.poll(step, now, this.emitFn, this.holdFn);
    const touchActive = this.touch.enabled && this.touch.poll(step, now, this.emitFn, this.holdFn);
    this.updateAxes(step, now, this.captured ? 0 : wheel);
    this.updateLevels(step);
    snap.pointerDx = this.captured ? 0 : this.look[0];
    snap.pointerDy = this.captured ? 0 : this.look[1];
    snap.mouseYoke = this.mouse.yokeEnabled;
    this.updateActiveDevice(kbActive, mouseActive, padActive, touchActive);
    return snap;
  }

  /** Per-axis "last mover wins" arbitration (§B1) and lever ownership (§B7 step 5). */
  private updateAxes(dt: number, now: number, wheelNotches: number): void {
    const axes = this.snapshot.axes;
    const c = this.controls;
    const ind = this.mouse.indicator;
    const touchOn = this.touch.enabled;
    for (let i = 0; i < CENTRING_AXES.length; i++) {
      const axis = CENTRING_AXES[i];
      const ai = axisIndexOf(axis);
      const stickAxis = axis === 'pitch' || axis === 'roll';
      let best = -Infinity, val = 0, src = -1;
      const gt = this.pads.lastChange(ai);
      if (gt > best) { best = gt; val = this.pads.value(ai); src = SRC_GAMEPAD; }
      if (touchOn && stickAxis && this.touch.stickLastChange > best) {
        best = this.touch.stickLastChange; val = axis === 'pitch' ? this.touch.stickY : this.touch.stickX; src = SRC_TOUCH;
      }
      if (ind.enabled && stickAxis && this.mouse.yokeLastActive > best) {
        best = this.mouse.yokeLastActive; val = axis === 'pitch' ? ind.y : ind.x; src = SRC_MOUSE;
      }
      if (this.keyboard.lastActive(axis) > best) { val = this.keyboard.value(axis); src = SRC_KEYS; }
      axes[axis] = src < 0 ? 0 : val;
    }
    c.pitch = axes.pitch; c.roll = axes.roll; c.yaw = axes.yaw;
    for (let li = 0; li < LEVERS.length; li++) {
      const lever = LEVERS[li];
      const ai = axisIndexOf(lever);
      let devTime = this.pads.lastChange(ai), devVal = this.pads.value(ai);
      if (li === 0 && touchOn && this.touch.throttleLastChange > devTime) { devTime = this.touch.throttleLastChange; devVal = this.touch.throttle; }
      if (devTime === now) { this.leverDeviceTime[li] = now; this.leverFollowsDevice[li] = true; }
      if (this.leverFollowsDevice[li] && devTime > -Infinity) c[lever] = clamp(devVal, 0, 1);
      const kd = this.keyboard.polledDirection(lever);
      if (kd !== 0 && this.mapperCtx.leverFree(lever)) {
        c[lever] = clamp(c[lever] + kd * this.rates.leverKeyRate * dt, 0, 1);
        this.leverFollowsDevice[li] = false;
      }
      axes[lever] = c[lever];
    }
    if (touchOn) this.touch.syncThrottle(c.throttle);
    const zi = axisIndexOf('cameraZoom');
    this.zoomLevel = clamp(this.zoomLevel + wheelNotches * this.mouse.options.wheelStep
      + (this.keyboard.polledDirection('cameraZoom') + this.pads.value(zi)) * dt, -1, 1);
    axes.cameraZoom = this.zoomLevel;
  }

  /** Level actions: brakesHold ramp merged with the brake axes, starter on transitions. */
  private updateLevels(dt: number): void {
    const c = this.controls, axes = this.snapshot.axes, r = this.rates;
    this.brakeHold = rampToward(this.brakeHold, this.brakesHeld ? 1 : 0, dt, r.brakeRampTime, r.brakeReleaseTime);
    c.brakeLeft = Math.max(axes.brakeLeft, this.brakeHold);
    c.brakeRight = Math.max(axes.brakeRight, this.brakeHold);
    axes.brakeLeft = c.brakeLeft;
    axes.brakeRight = c.brakeRight;
    // starter written only on transitions so the simulator's auto-start sequence can drive it too
    if (this.starterHeld !== this.starterWasHeld) { c.starter = this.starterHeld; this.starterWasHeld = this.starterHeld; }
  }

  private updateActiveDevice(kb: boolean, mouse: boolean, pad: number, touch: boolean): void {
    const dev: InputDeviceKind | null = pad >= 0 ? 'gamepad' : touch ? 'touch' : mouse ? 'mouse' : kb ? 'keyboard' : null;
    if (!dev) return;
    if (dev === this.activeDevice && (dev !== 'gamepad' || pad === this.activePadIndex)) return;
    this.activeDevice = dev;
    if (dev === 'gamepad') this.activePadIndex = pad;
    this.notify({ kind: 'active', device: dev, pad: dev === 'gamepad' ? this.pads.padInfo(pad) ?? undefined : undefined });
  }

  // ───────────────────────────── bindings: labels & lists ─────────────────────────────

  /** Active keyboard (+ mouse) profile. */
  get keyboardProfile(): BindingProfile { return this.profiles.keyboard; }

  /** Profile used by a connected pad (default: the active / first pad), or null without pads. */
  gamepadProfile(padIndex = this.pads.preferredPad()): BindingProfile | null {
    const r = this.pads.resolved(padIndex);
    return r ? this.profiles.gamepad(r) : null;
  }

  /** Problems found in stored bindings at start-up (they were skipped). */
  get loadErrors(): readonly string[] { return this.profiles.loadErrors; }

  private labelSources(prefer?: 'keyboard' | 'gamepad'): LabelSource[] {
    const kb: LabelSource = { profile: this.profiles.keyboard, standard: true };
    const r = this.pads.resolved(this.pads.preferredPad());
    if (!r) return [kb];
    const pad: LabelSource = { profile: this.profiles.gamepad(r), standard: r.standard, buttonNames: r.preset.buttonNames };
    const preferPad = (prefer ?? (this.activeDevice === 'gamepad' ? 'gamepad' : 'keyboard')) === 'gamepad';
    return preferPad ? [pad, kb] : [kb, pad];
  }

  /**
   * Label of the primary binding of an action: "Ctrl+E", "Num 7", "Pad A" ('' if unbound).
   * Prefers `device`, else the last active device (keyboard for mouse/touch).
   */
  getBindingLabel(action: BindableAction, device?: 'keyboard' | 'gamepad'): string {
    return labelsFor(`action:${action}`, this.labelSources(device)).labels[0] ?? '';
  }

  /** Labels of every binding of an action (preferred device first). */
  getBindingLabels(action: BindableAction, device?: 'keyboard' | 'gamepad'): string[] {
    return labelsFor(`action:${action}`, this.labelSources(device)).labels;
  }

  /** One row per SimAction for the controls page / help sheet (UI `BindingInfo`-compatible). */
  bindingsList(): BindingRow[] { return buildBindingRows(this.labelSources()); }

  /** Rows for axis keys/sticks and input-local actions (mouse yoke, free-look, propeller …). */
  controlsList(): ControlRow[] { return buildControlRows(this.labelSources()); }

  /** Conflicts in the active keyboard profile and in each connected pad's profile. */
  conflicts(): BindingConflict[] {
    const out = findConflicts(this.profiles.keyboard.bindings);
    for (const p of this.pads.connected()) {
      const r = this.pads.resolved(p.index);
      if (r) out.push(...findConflicts(this.profiles.gamepad(r).bindings));
    }
    return out;
  }

  // ───────────────────────────── bindings: profiles ─────────────────────────────

  /**
   * Switches layout. Keyboard: 'default' (MSFS + laptop), 'msfs', 'laptop' or a keyboard
   * BindingProfile. Gamepad: 'gamepad-xbox', 'joystick-generic' or a gamepad BindingProfile,
   * applied to pads with `deviceKey` (default: the active pad's key, else 'standard'). Persists.
   */
  setProfile(p: ProfileId | BindingProfile, deviceKey?: string): void {
    if (typeof p === 'string') {
      if (!isProfileId(p)) return;
      if (isKeyboardProfileId(p)) this.profiles.setKeyboard(defaultProfile(p));
      else {
        const r = this.pads.resolved(this.pads.preferredPad());
        const key = deviceKey ?? r?.deviceKey ?? (p === 'gamepad-xbox' ? 'standard' : HID_WILDCARD);
        const prof = r && r.deviceKey === key && r.preset.profile === p ? this.profiles.presetProfile(r) : defaultProfile(p);
        this.profiles.setGamepad(key, prof);
      }
    } else if (p.device === 'keyboard') this.profiles.setKeyboard(p);
    else this.profiles.setGamepad(deviceKey ?? this.pads.resolved(this.pads.preferredPad())?.deviceKey ?? 'standard', p);
    this.applyProfiles();
  }

  /**
   * Resets bindings to the built-in defaults: a keyboard id selects that layout, a gamepad id
   * clears overrides for that device class, no id resets everything and clears storage.
   */
  resetProfile(id?: ProfileId): void {
    this.profiles.reset(id);
    this.applyProfiles();
  }

  private applyProfiles(): void {
    const kb = this.profiles.keyboard.bindings;
    this.keyboard.setBindings(kb);
    this.mouse.setBindings(kb);
    this.pads.refreshProfiles();
  }

  // ───────────────────────────── rebinding ─────────────────────────────

  /**
   * Waits for the next key chord (keyboard) or button / axis push (gamepad) and binds it to
   * `action`, replacing that action's binding on that device and displacing whatever used the
   * input before (reported for swap UIs). Esc cancels; modifier-only presses are ignored.
   * Resolves null on cancel / timeout / a newer startListening call.
   */
  startListening<A extends BindableAction>(action: A, opts: ListenOptions = {}): Promise<RebindResult<A> | null> {
    const meta = isSimAction(action) ? SIM_ACTION_META[action] : LOCAL_ACTION_META[action as Exclude<A, SimAction>];
    return this.listen(opts, (input) => ({ ...input, action }), (b, displaced, label) =>
      ({ action, label, device: b.device === 'gamepad' ? 'gamepad' : 'keyboard', group: meta.group, binding: b, displaced }));
  }

  /**
   * Like startListening for an axis: keys / buttons push it towards `dir`; a gamepad axis moved
   * towards the "positive" end (pull back, rudder right, lever full) is bound non-inverted.
   */
  startListeningAxis(axis: SimAxis, dir: 1 | -1 = 1, opts: ListenOptions = {}): Promise<{ axis: SimAxis; dir: 1 | -1; label: string; binding: Binding; displaced: Binding[] } | null> {
    return this.listen(opts, (input) => {
      if (input.device === 'gamepad' && input.axisIndex !== undefined) {
        const invert = (input.axisDir ?? 1) !== dir;
        return { device: 'gamepad', axisIndex: input.axisIndex, axis, ...(invert ? { invert: true } : {}), ...(LEVER_AXES.has(axis) ? { unipolar: true } : {}) };
      }
      return { ...input, axis, dir };
    }, (binding, displaced, label) => ({ axis, dir, label, binding, displaced }));
  }

  /** Cancels a pending startListening / startListeningAxis (its promise resolves to null). */
  cancelListening(): void { this.capture?.cancel(); }

  private listen<R>(opts: ListenOptions, make: (input: CapturedInput) => Binding, done: (b: Binding, displaced: Binding[], label: string) => R): Promise<R | null> {
    this.cancelListening();
    return new Promise<R | null>((resolve) => {
      this.capture = captureNextInput(this.keyboard, this.pads, opts, (input, r) => {
        this.capture = null;
        if (!input || this.disposed) { resolve(null); return; }
        const b = make(input);
        const out = b.device === 'gamepad' && r ? this.profiles.rebindGamepad(r, b) : this.profiles.rebindKeyboard(b);
        this.applyProfiles();
        const src: LabelSource = r ? { profile: out.profile, standard: r.standard, buttonNames: r.preset.buttonNames } : { profile: out.profile, standard: true };
        resolve(done(b, out.displaced, labelsFor(targetKey(b), [src]).labels[0] ?? ''));
      });
    });
  }

  // ───────────────────────────── teardown ─────────────────────────────

  /** Removes every listener and DOM element; pending listens resolve null. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.cancelListening();
    this.disposed = true;
    this.keyboard.detach();
    this.mouse.detach();
    this.pads.detach();
    this.pads.onConnection = null;
    this.touch.disable();
    this.listeners = [];
  }
}

/** Lever index (LEVERS order) moved by an action, or −1. */
function leverOfAction(a: BindableAction): number {
  if (a.startsWith('throttle')) return 0;
  if (a.startsWith('mixture')) return 1;
  if (a.startsWith('propeller')) return 2;
  return -1;
}
