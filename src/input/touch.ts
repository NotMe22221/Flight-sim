/**
 * Touch controls (§B6): a dynamic virtual stick on the left (appears under the thumb,
 * → pitch/roll), a sticky throttle slider on the right, and buttons (flaps ±, gear, brakes
 * hold, camera, menu). Pointer Events only; DOM is created by enable(container) and removed
 * by disable(). Values are read by the InputManager each poll.
 */
import type { BindableAction } from './actions';
import { actionMeta } from './actions';
import { HoldTracker } from './keyAxis';
import { type AxisShaping, makeShaping, shapeStick } from './shaping';

export interface TouchButtonSpec { id: string; label: string; action: BindableAction }

export interface TouchOptions {
  /** thumb travel for full deflection, CSS px (default 120) */
  stickRadiusPx: number;
  /** stick shaping (default deadzone 0.08, curve 0.3) */
  stickShaping: AxisShaping;
  buttons: TouchButtonSpec[];
}

export const DEFAULT_TOUCH_BUTTONS: readonly TouchButtonSpec[] = [
  { id: 'flaps-up', label: 'FLAPS −', action: 'flapsUp' },
  { id: 'flaps-down', label: 'FLAPS +', action: 'flapsDown' },
  { id: 'gear', label: 'GEAR', action: 'gearToggle' },
  { id: 'brakes', label: 'BRAKE', action: 'brakesHold' },
  { id: 'camera', label: 'VIEW', action: 'cameraNext' },
  { id: 'menu', label: 'MENU', action: 'toggleMenu' },
];

/**
 * Thumb offset (px from where the touch started) → shaped stick [x, y] in −1..1
 * (x = roll right, y = pull back / nose up). Written into `out`.
 */
export function stickFromDrag(dx: number, dy: number, radiusPx: number, shaping: AxisShaping, out: [number, number]): [number, number] {
  const r = Math.max(1, radiusPx);
  let x = dx / r, y = dy / r;
  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  return shapeStick(x, y, shaping, out);
}

/** Sets inline styles by CSS property name (falls back to plain assignment for minimal DOMs). */
function css(el: HTMLElement, s: Record<string, string>): void {
  const st = el.style as CSSStyleDeclaration & Record<string, string>;
  for (const k in s) {
    if (typeof st.setProperty === 'function') st.setProperty(k, s[k]);
    else st[k] = s[k];
  }
}

export class TouchControls {
  readonly options: TouchOptions;
  readonly tracker: HoldTracker<BindableAction>;
  /** shaped stick output (x = roll, y = pitch) */
  stickX = 0;
  stickY = 0;
  /** lever position 0..1 */
  throttle = 0;
  /** manager-clock times of the last change, for arbitration */
  stickLastChange = -Infinity;
  throttleLastChange = -Infinity;
  private root: HTMLElement | null = null;
  private zone: HTMLElement | null = null;
  private base: HTMLElement | null = null;
  private knob: HTMLElement | null = null;
  private track: HTMLElement | null = null;
  private thumb: HTMLElement | null = null;
  private buttonEls: HTMLElement[] = [];
  private stickPointer = -1;
  private stickX0 = 0;
  private stickY0 = 0;
  private sliderPointer = -1;
  private stickDirty = false;
  private throttleDirty = false;
  private activity = false;
  private out: [number, number] = [0, 0];
  private buttonPointers = new Map<number, BindableAction>();

  constructor(options: Partial<TouchOptions> = {}) {
    this.options = {
      stickRadiusPx: options.stickRadiusPx ?? 120,
      stickShaping: options.stickShaping ?? makeShaping({ deadzone: 0.08, curve: 0.3, saturation: 1 }),
      buttons: options.buttons ?? DEFAULT_TOUCH_BUTTONS.slice(),
    };
    this.tracker = new HoldTracker<BindableAction>((a) => actionMeta(a));
  }

  get enabled(): boolean { return this.root !== null; }

  /** Creates the overlay inside `container` (idempotent). */
  enable(container: HTMLElement): void {
    if (this.root) return;
    const doc = container.ownerDocument;
    const mk = (tag: string, role: string): HTMLElement => { const e = doc.createElement(tag); e.dataset.input = role; return e; };
    const root = mk('div', 'touch-root');
    css(root, { position: 'absolute', inset: '0', 'pointer-events': 'none', 'user-select': 'none', 'z-index': '5' });
    const zone = mk('div', 'stick-zone');
    css(zone, { position: 'absolute', left: '0', bottom: '0', width: '45%', height: '60%', 'pointer-events': 'auto', 'touch-action': 'none' });
    const base = mk('div', 'stick-base');
    const d = `${this.options.stickRadiusPx * 2}px`;
    css(base, { position: 'absolute', width: d, height: d, 'border-radius': '50%', border: '2px solid rgba(255,255,255,0.5)', display: 'none', transform: 'translate(-50%,-50%)' });
    const knob = mk('div', 'stick-knob');
    css(knob, { position: 'absolute', width: '56px', height: '56px', 'border-radius': '50%', background: 'rgba(255,255,255,0.6)', display: 'none', transform: 'translate(-50%,-50%)' });
    zone.appendChild(base); zone.appendChild(knob);
    const track = mk('div', 'throttle-track');
    css(track, { position: 'absolute', right: '24px', bottom: '96px', width: '56px', height: '40%', 'border-radius': '12px', background: 'rgba(0,0,0,0.35)', 'pointer-events': 'auto', 'touch-action': 'none' });
    const thumb = mk('div', 'throttle-thumb');
    css(thumb, { position: 'absolute', left: '0', width: '56px', height: '24px', 'border-radius': '8px', background: 'rgba(255,255,255,0.8)', bottom: '0%' });
    track.appendChild(thumb);
    const bar = mk('div', 'touch-buttons');
    css(bar, { position: 'absolute', right: '8px', bottom: '8px', display: 'flex', gap: '6px', 'pointer-events': 'auto', 'touch-action': 'none' });
    this.buttonEls = [];
    for (const spec of this.options.buttons) {
      const b = mk('div', 'touch-button');
      b.dataset.action = spec.action;
      b.dataset.id = spec.id;
      b.textContent = spec.label;
      b.setAttribute('role', 'button');
      css(b, { padding: '10px 12px', 'border-radius': '8px', background: 'rgba(0,0,0,0.45)', color: '#fff', font: '600 12px system-ui, sans-serif' });
      b.addEventListener('pointerdown', this.onButtonDown);
      b.addEventListener('pointerup', this.onButtonUp);
      b.addEventListener('pointercancel', this.onButtonUp);
      b.addEventListener('pointerleave', this.onButtonUp);
      bar.appendChild(b);
      this.buttonEls.push(b);
    }
    root.appendChild(zone); root.appendChild(track); root.appendChild(bar);
    zone.addEventListener('pointerdown', this.onStickDown);
    zone.addEventListener('pointermove', this.onStickMove);
    zone.addEventListener('pointerup', this.onStickUp);
    zone.addEventListener('pointercancel', this.onStickUp);
    track.addEventListener('pointerdown', this.onSliderDown);
    track.addEventListener('pointermove', this.onSliderMove);
    track.addEventListener('pointerup', this.onSliderUp);
    track.addEventListener('pointercancel', this.onSliderUp);
    container.appendChild(root);
    this.root = root; this.zone = zone; this.base = base; this.knob = knob; this.track = track; this.thumb = thumb;
    this.renderThrottle();
  }

  /** Removes the overlay and all listeners; releases held buttons and centres the stick. */
  disable(): void {
    const { root, zone, track } = this;
    if (!root || !zone || !track) return;
    zone.removeEventListener('pointerdown', this.onStickDown);
    zone.removeEventListener('pointermove', this.onStickMove);
    zone.removeEventListener('pointerup', this.onStickUp);
    zone.removeEventListener('pointercancel', this.onStickUp);
    track.removeEventListener('pointerdown', this.onSliderDown);
    track.removeEventListener('pointermove', this.onSliderMove);
    track.removeEventListener('pointerup', this.onSliderUp);
    track.removeEventListener('pointercancel', this.onSliderUp);
    for (const b of this.buttonEls) {
      b.removeEventListener('pointerdown', this.onButtonDown);
      b.removeEventListener('pointerup', this.onButtonUp);
      b.removeEventListener('pointercancel', this.onButtonUp);
      b.removeEventListener('pointerleave', this.onButtonUp);
    }
    root.remove();
    this.root = this.zone = this.base = this.knob = this.track = this.thumb = null;
    this.buttonEls = [];
    this.buttonPointers.clear();
    this.tracker.releaseAll();
    this.stickPointer = -1; this.sliderPointer = -1;
    this.stickX = 0; this.stickY = 0;
  }

  /**
   * Focus loss: releases held buttons and centres the stick (their pointerup may never arrive);
   * the throttle slider keeps its position.
   */
  releaseAll(): void {
    this.buttonPointers.clear();
    this.tracker.releaseAll();
    this.sliderPointer = -1;
    if (this.stickPointer >= 0 || this.stickX !== 0 || this.stickY !== 0) {
      this.stickPointer = -1;
      this.stickX = 0; this.stickY = 0; this.stickDirty = true;
      if (this.base) css(this.base, { display: 'none' });
      if (this.knob) css(this.knob, { display: 'none' });
    }
  }

  /** Moves the slider to an externally changed throttle (keyboard / UI) when not being touched. */
  syncThrottle(v: number): void {
    if (this.sliderPointer >= 0 || v === this.throttle) return;
    this.throttle = v;
    this.renderThrottle();
  }

  /** Reports changes since the last poll. Returns true on touch activity. */
  poll(dt: number, now: number, emit: (a: BindableAction) => void, hold: (a: BindableAction) => void): boolean {
    if (this.stickDirty) { this.stickLastChange = now; this.stickDirty = false; }
    if (this.throttleDirty) { this.throttleLastChange = now; this.throttleDirty = false; }
    this.tracker.poll(dt, emit, hold);
    const a = this.activity;
    this.activity = false;
    return a;
  }

  private setStick(dx: number, dy: number): void {
    stickFromDrag(dx, dy, this.options.stickRadiusPx, this.options.stickShaping, this.out);
    this.stickX = this.out[0]; this.stickY = this.out[1];
    this.stickDirty = true; this.activity = true;
    const r = this.options.stickRadiusPx;
    const m = Math.hypot(dx, dy);
    const k = m > r ? r / m : 1;
    if (this.knob) css(this.knob, { left: `${this.stickX0 + dx * k}px`, top: `${this.stickY0 + dy * k}px` });
  }

  private readonly onStickDown = (e: PointerEvent): void => {
    if (this.stickPointer >= 0 || !this.zone) return;
    e.preventDefault();
    this.stickPointer = e.pointerId;
    try { this.zone.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const r = this.zone.getBoundingClientRect();
    this.stickX0 = e.clientX - r.left; this.stickY0 = e.clientY - r.top;
    for (const el of [this.base, this.knob]) if (el) css(el, { display: 'block', left: `${this.stickX0}px`, top: `${this.stickY0}px` });
    this.setStick(0, 0);
  };

  private readonly onStickMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickPointer || !this.zone) return;
    const r = this.zone.getBoundingClientRect();
    this.setStick(e.clientX - r.left - this.stickX0, e.clientY - r.top - this.stickY0);
  };

  private readonly onStickUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickPointer) return;
    this.stickPointer = -1;
    this.stickX = 0; this.stickY = 0; this.stickDirty = true; this.activity = true;
    for (const el of [this.base, this.knob]) if (el) css(el, { display: 'none' });
  };

  private sliderFrom(e: PointerEvent): void {
    if (!this.track) return;
    const r = this.track.getBoundingClientRect();
    const v = 1 - (e.clientY - r.top) / Math.max(1, r.height);
    this.throttle = v < 0 ? 0 : v > 1 ? 1 : v;
    this.throttleDirty = true; this.activity = true;
    this.renderThrottle();
  }

  private renderThrottle(): void {
    if (this.thumb) css(this.thumb, { bottom: `calc(${(this.throttle * 100).toFixed(1)}% - ${(this.throttle * 24).toFixed(1)}px)` });
  }

  private readonly onSliderDown = (e: PointerEvent): void => {
    if (this.sliderPointer >= 0 || !this.track) return;
    e.preventDefault();
    this.sliderPointer = e.pointerId;
    try { this.track.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    this.sliderFrom(e);
  };

  private readonly onSliderMove = (e: PointerEvent): void => { if (e.pointerId === this.sliderPointer) this.sliderFrom(e); };

  private readonly onSliderUp = (e: PointerEvent): void => { if (e.pointerId === this.sliderPointer) this.sliderPointer = -1; };

  private readonly onButtonDown = (e: PointerEvent): void => {
    const el = e.currentTarget as HTMLElement | null;
    const action = el?.dataset.action as BindableAction | undefined;
    if (!action || this.buttonPointers.has(e.pointerId)) return;
    e.preventDefault();
    this.buttonPointers.set(e.pointerId, action);
    this.tracker.press(action);
    this.activity = true;
  };

  private readonly onButtonUp = (e: PointerEvent): void => {
    const action = this.buttonPointers.get(e.pointerId);
    if (!action) return;
    this.buttonPointers.delete(e.pointerId);
    this.tracker.release(action);
  };
}
