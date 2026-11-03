/**
 * Mouse source, listening only on the canvas element it is given (UI elements keep their
 * clicks): right-button drag free-look (pointer capture) or a toggled pointer-lock free-look,
 * an optional mouse yoke (§B4.2), wheel → `cameraZoom` level (+ zoomIn/zoomOut actions), and
 * mouse-button bindings (middle = reset view by default).
 */
import { clamp } from '../core/math';
import { type BindableAction, actionMeta } from './actions';
import { type ActionBinding, type Binding, isActionBinding } from './bindings';
import { HoldTracker } from './keyAxis';
import { boxDeadzone, curveMagnitude } from './shaping';

export type MouseYokeMode = 'absolute' | 'relative';

export interface MouseOptions {
  /** 'absolute' = stick follows the cursor offset from the canvas centre; 'relative' = movement deltas (pointer lock) */
  yokeMode: MouseYokeMode;
  /** cursor distance from centre for full deflection, CSS px (default 250; slider 150–600) */
  yokeRadiusPx: number;
  /** half-size of the square deadzone box around the centre, CSS px (default 12) */
  yokeDeadzonePx: number;
  /** multiplier on deflection per pixel (default 1) */
  yokeSensitivity: number;
  /** response curve 0..1 (default 0.2) */
  yokeCurve: number;
  /** false: cursor below centre = pull back = nose up */
  yokeInvertPitch: boolean;
  /** the yoke only engages once the cursor has passed through the deadzone box (no jerk on enable) */
  yokeEngageAtCentre: boolean;
  /** cameraZoom level change per wheel notch (default 0.1) */
  wheelStep: number;
  /** also emit zoomIn/zoomOut actions per wheel notch (default true) */
  wheelActions: boolean;
  /** use pointer lock (raw deltas) during right-drag instead of pointer capture (default false) */
  lockOnDrag: boolean;
}

export const DEFAULT_MOUSE_OPTIONS: Readonly<MouseOptions> = {
  yokeMode: 'absolute', yokeRadiusPx: 250, yokeDeadzonePx: 12, yokeSensitivity: 1, yokeCurve: 0.2,
  yokeInvertPitch: false, yokeEngageAtCentre: true, wheelStep: 0.1, wheelActions: true, lockOnDrag: false,
};

/** Mouse-yoke state for the HUD crosshair / deadzone box. */
export interface YokeIndicator {
  enabled: boolean;
  /** false until the cursor has visited the centre box after enabling */
  engaged: boolean;
  /** shaped stick output, −1..1 (x = roll, y = pitch, +y = nose up) */
  x: number;
  y: number;
  /** cursor offset from the canvas centre, CSS px (absolute mode) */
  offsetX: number;
  offsetY: number;
  /** canvas centre in client coordinates */
  centerX: number;
  centerY: number;
  deadzonePx: number;
  radiusPx: number;
}

const BUTTON_BITS = [1, 4, 2, 8, 16]; // MouseEvent.button → MouseEvent.buttons bit

export class MouseSource {
  readonly options: MouseOptions;
  readonly tracker: HoldTracker<BindableAction>;
  readonly indicator: YokeIndicator;
  /** pointer delta accumulated for free-look since the last poll, px */
  private dx = 0;
  private dy = 0;
  private wheelAcc = 0;
  private wheelActionAcc = 0;
  private buttons = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private relX = 0;
  private relY = 0;
  private freeLock = false;
  private moved = false;
  private yokeMoved = false;
  private attached = false;
  private buttonBindings: ActionBinding[] = [];
  /** wheel sensitivity from the wheel binding (1 when unbound) */
  private wheelGain = 1;
  private wheelBound = true;
  /** last manager-clock time the yoke output changed */
  yokeLastActive = -Infinity;

  constructor(private el: HTMLElement, private doc: Document | null, bindings: readonly Binding[], options: Partial<MouseOptions> = {}) {
    this.options = { ...DEFAULT_MOUSE_OPTIONS, ...options };
    this.tracker = new HoldTracker<BindableAction>((a) => actionMeta(a));
    this.indicator = {
      enabled: false, engaged: false, x: 0, y: 0, offsetX: 0, offsetY: 0, centerX: 0, centerY: 0,
      deadzonePx: this.options.yokeDeadzonePx, radiusPx: this.options.yokeRadiusPx,
    };
    this.setBindings(bindings);
  }

  /** Picks the mouse bindings out of a profile. */
  setBindings(bindings: readonly Binding[]): void {
    this.tracker.releaseAll();
    this.buttonBindings = [];
    this.wheelBound = false;
    this.wheelGain = 1;
    for (const b of bindings) {
      if (b.device !== 'mouse') continue;
      if (isActionBinding(b)) { if (!b.wheel) this.buttonBindings.push(b); }
      else if (b.wheel && b.axis === 'cameraZoom') { this.wheelBound = true; this.wheelGain = (b.sensitivity ?? 1) * (b.invert ? -1 : 1); }
    }
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const el = this.el;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', this.onContextMenu);
    this.doc?.addEventListener('pointerlockchange', this.onLockChange);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const el = this.el;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerUp);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('contextmenu', this.onContextMenu);
    this.doc?.removeEventListener('pointerlockchange', this.onLockChange);
    this.setFreeLook(false);
    this.releaseAll();
  }

  /** Enables / disables the mouse yoke. Enabling re-arms the centre-engage guard. */
  setYoke(enabled: boolean): void {
    const ind = this.indicator;
    if (ind.enabled === enabled) return;
    ind.enabled = enabled;
    ind.engaged = enabled && !this.options.yokeEngageAtCentre;
    ind.x = 0; ind.y = 0; this.relX = 0; this.relY = 0;
    if (enabled && this.options.yokeMode === 'relative') this.requestLock();
  }

  get yokeEnabled(): boolean { return this.indicator.enabled; }

  /** Toggles a persistent pointer-lock free-look (no button needed). */
  setFreeLook(on: boolean): void {
    if (on) {
      this.freeLock = true;
      this.requestLock(); // no-op while locked; a refused request (no gesture, sandbox) is retried by the next toggle
      return;
    }
    if (!this.freeLock) return;
    this.freeLock = false;
    if (this.doc && this.doc.pointerLockElement === this.el && !(this.indicator.enabled && this.options.yokeMode === 'relative')) this.doc.exitPointerLock();
  }

  /** True while the pointer-lock free-look is on and the browser granted the lock. */
  get freeLookLocked(): boolean { return this.freeLock && this.locked; }

  /** Whether the pointer is currently locked to our canvas. */
  get locked(): boolean { return !!this.doc && this.doc.pointerLockElement === this.el; }

  /** Releases buttons and drags (focus loss). */
  releaseAll(): void {
    this.buttons = 0;
    this.dragging = false;
    this.tracker.releaseAll();
  }

  /**
   * Collects this frame's mouse input. Writes the free-look delta to `look` [dx, dy] and the
   * wheel notches to the return value (positive = zoom in). Emits button / wheel actions.
   * Returns true if the mouse produced any activity since the last poll.
   */
  poll(dt: number, now: number, look: [number, number], emit: (a: BindableAction) => void, hold: (a: BindableAction) => void): number {
    look[0] = this.dx; look[1] = this.dy;
    this.dx = 0; this.dy = 0;
    const notches = this.wheelBound ? this.wheelAcc * this.wheelGain : 0;
    if (this.options.wheelActions && this.wheelBound) {
      this.wheelActionAcc += notches;
      let n = 0;
      while (this.wheelActionAcc >= 1 && n++ < 8) { emit('zoomIn'); this.wheelActionAcc -= 1; }
      while (this.wheelActionAcc <= -1 && n++ < 8) { emit('zoomOut'); this.wheelActionAcc += 1; }
      if (Math.abs(this.wheelActionAcc) >= 1) this.wheelActionAcc = 0;
    }
    this.wheelAcc = 0;
    this.tracker.poll(dt, emit, hold);
    if (this.indicator.enabled && this.yokeMoved) this.yokeLastActive = now;
    this.yokeMoved = false;
    return notches;
  }

  /** True if any mouse input happened since the last call (active-device tracking). */
  consumeActivity(): boolean { const m = this.moved; this.moved = false; return m; }

  /** Updates the yoke from a cursor position in client coordinates (absolute mode). Exposed for tests/UI. */
  setCursor(clientX: number, clientY: number): void {
    const r = this.el.getBoundingClientRect();
    const ind = this.indicator;
    ind.centerX = r.left + r.width / 2;
    ind.centerY = r.top + r.height / 2;
    ind.offsetX = clientX - ind.centerX;
    ind.offsetY = clientY - ind.centerY;
    this.updateYoke();
  }

  private updateYoke(): void {
    const o = this.options, ind = this.indicator;
    ind.deadzonePx = o.yokeDeadzonePx;
    ind.radiusPx = o.yokeRadiusPx;
    if (!ind.enabled) return;
    let rx: number, ry: number;
    if (o.yokeMode === 'absolute') {
      if (!ind.engaged && Math.abs(ind.offsetX) <= o.yokeDeadzonePx && Math.abs(ind.offsetY) <= o.yokeDeadzonePx) ind.engaged = true;
      rx = boxDeadzone(ind.offsetX, o.yokeDeadzonePx, o.yokeRadiusPx, o.yokeSensitivity);
      ry = boxDeadzone(ind.offsetY, o.yokeDeadzonePx, o.yokeRadiusPx, o.yokeSensitivity);
    } else {
      ind.engaged = true;
      const dz = o.yokeDeadzonePx / o.yokeRadiusPx;
      rx = Math.sign(this.relX) * Math.min(1, Math.max(0, Math.abs(this.relX) - dz) / (1 - dz));
      ry = Math.sign(this.relY) * Math.min(1, Math.max(0, Math.abs(this.relY) - dz) / (1 - dz));
    }
    if (!ind.engaged) { rx = 0; ry = 0; }
    const x = Math.sign(rx) * curveMagnitude(Math.abs(rx), o.yokeCurve);
    let y = Math.sign(ry) * curveMagnitude(Math.abs(ry), o.yokeCurve);
    if (o.yokeInvertPitch && y !== 0) y = -y;
    if (x !== ind.x || y !== ind.y) this.yokeMoved = true;
    ind.x = x; ind.y = y;
  }

  private requestLock(): void {
    const el = this.el as HTMLElement & { requestPointerLock?: (o?: { unadjustedMovement?: boolean }) => Promise<void> | void };
    if (!el.requestPointerLock || this.locked) return;
    try {
      const p = el.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => {
          // NotSupportedError for unadjustedMovement: retry without the option
          try { const q = el.requestPointerLock?.(); if (q && typeof (q as Promise<void>).catch === 'function') (q as Promise<void>).catch(() => undefined); } catch { /* no lock */ }
        });
      }
    } catch { /* pointer lock unavailable (iframe sandbox, no gesture) */ }
  }

  private updateButtons(buttons: number, e: PointerEvent): void {
    const prev = this.buttons;
    if (prev === buttons) return;
    this.buttons = buttons;
    this.moved = true;
    for (let b = 0; b < BUTTON_BITS.length; b++) {
      const bit = BUTTON_BITS[b];
      const was = (prev & bit) !== 0, is = (buttons & bit) !== 0;
      if (was === is) continue;
      if (b === 2) this.setDrag(is, e);
      for (const bb of this.buttonBindings) {
        if (bb.button !== b) continue;
        if (is && (!!bb.ctrl !== e.ctrlKey || !!bb.shift !== e.shiftKey || !!bb.alt !== e.altKey)) continue;
        if (is) this.tracker.press(bb.action); else this.tracker.release(bb.action);
      }
    }
  }

  private setDrag(on: boolean, e: PointerEvent): void {
    this.dragging = on;
    this.lastX = e.clientX; this.lastY = e.clientY;
    if (on) {
      if (this.options.lockOnDrag) this.requestLock();
      else { try { this.el.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ } }
    } else {
      try { this.el.releasePointerCapture?.(e.pointerId); } catch { /* already released */ }
      if (this.options.lockOnDrag && !this.freeLock && this.locked) this.doc?.exitPointerLock();
    }
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    this.updateButtons(e.buttons || BUTTON_BITS[e.button] || 0, e);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    this.updateButtons(e.buttons, e);
    const locked = this.locked;
    const mx = locked ? e.movementX : e.clientX - this.lastX;
    const my = locked ? e.movementY : e.clientY - this.lastY;
    this.lastX = e.clientX; this.lastY = e.clientY;
    if (mx !== 0 || my !== 0) this.moved = true;
    const relativeYoke = this.indicator.enabled && this.options.yokeMode === 'relative';
    if (relativeYoke) {
      const k = this.options.yokeSensitivity / this.options.yokeRadiusPx;
      this.relX = clamp(this.relX + e.movementX * k, -1, 1);
      this.relY = clamp(this.relY + e.movementY * k, -1, 1);
      this.updateYoke();
    } else if (this.indicator.enabled) {
      this.setCursor(e.clientX, e.clientY);
    }
    if (this.dragging || (this.freeLock && locked && !relativeYoke)) { this.dx += mx; this.dy += my; }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    this.updateButtons(e.type === 'pointercancel' ? 0 : e.buttons, e);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.wheelBound) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 1 : 100; // pixels / lines / pages per notch
    this.wheelAcc += -e.deltaY / unit;
    this.moved = true;
  };

  private readonly onContextMenu = (e: Event): void => { e.preventDefault(); };

  private readonly onLockChange = (): void => {
    if (!this.locked) {
      if (this.freeLock) this.freeLock = false;
      if (this.indicator.enabled && this.options.yokeMode === 'relative') this.setYoke(false);
    }
  };
}
