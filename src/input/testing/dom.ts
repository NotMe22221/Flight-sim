/**
 * Minimal fake DOM for Node tests of the input module (no jsdom dependency):
 * EventTarget, elements with style/children/rect/pointer capture, a document with pointer
 * lock and visibility, a window, `navigator.getGamepads()` with scriptable pads, storage.
 * Production code is typed against the real DOM; tests cast via `makeFakeDom().env`.
 */
import type { StorageLike } from '../bindingStore';

type Listener = (e: FakeEvent) => void;
type ListenerLike = Listener | { handleEvent(e: FakeEvent): void };

export class FakeEvent {
  defaultPrevented = false;
  target: unknown = null;
  currentTarget: unknown = null;
  constructor(public readonly type: string) {}
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { /* no propagation in the fake */ }
}

export interface Mods { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; repeat?: boolean }

export class FakeKeyboardEvent extends FakeEvent {
  ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; repeat: boolean; key: string;
  constructor(type: 'keydown' | 'keyup', public readonly code: string, m: Mods = {}) {
    super(type);
    this.ctrlKey = !!m.ctrl; this.shiftKey = !!m.shift; this.altKey = !!m.alt; this.metaKey = !!m.meta; this.repeat = !!m.repeat;
    this.key = code.startsWith('Key') ? code.slice(3).toLowerCase() : code;
  }
}

export interface PointerInit {
  button?: number; buttons?: number; clientX?: number; clientY?: number; movementX?: number; movementY?: number;
  pointerId?: number; pointerType?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean;
}

export class FakePointerEvent extends FakeEvent {
  button: number; buttons: number; clientX: number; clientY: number; movementX: number; movementY: number;
  pointerId: number; pointerType: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean;
  constructor(type: string, i: PointerInit = {}) {
    super(type);
    this.button = i.button ?? 0; this.buttons = i.buttons ?? 0; this.clientX = i.clientX ?? 0; this.clientY = i.clientY ?? 0;
    this.movementX = i.movementX ?? 0; this.movementY = i.movementY ?? 0; this.pointerId = i.pointerId ?? 1;
    this.pointerType = i.pointerType ?? 'mouse'; this.ctrlKey = !!i.ctrlKey; this.shiftKey = !!i.shiftKey; this.altKey = !!i.altKey;
  }
}

export class FakeWheelEvent extends FakeEvent {
  constructor(public readonly deltaY: number, public readonly deltaMode = 0, public readonly deltaX = 0) { super('wheel'); }
}

export class FakeEventTarget {
  private listeners = new Map<string, ListenerLike[]>();
  addEventListener(type: string, fn: ListenerLike | null, _opts?: unknown): void {
    if (!fn) return;
    const list = this.listeners.get(type) ?? [];
    if (!list.includes(fn)) list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: ListenerLike | null, _opts?: unknown): void {
    const list = this.listeners.get(type);
    if (!list || !fn) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatchEvent(e: FakeEvent): boolean {
    if (e.target === null) e.target = this;
    e.currentTarget = this;
    for (const fn of [...(this.listeners.get(e.type) ?? [])]) {
      if (typeof fn === 'function') fn(e); else fn.handleEvent(e);
    }
    return !e.defaultPrevented;
  }
  /** Number of registered listeners (all types, or one type). */
  listenerCount(type?: string): number {
    if (type) return this.listeners.get(type)?.length ?? 0;
    let n = 0;
    for (const l of this.listeners.values()) n += l.length;
    return n;
  }
}

export class FakeClassList {
  private set = new Set<string>();
  add(...c: string[]): void { for (const x of c) this.set.add(x); }
  remove(...c: string[]): void { for (const x of c) this.set.delete(x); }
  toggle(c: string, force?: boolean): boolean {
    const on = force ?? !this.set.has(c);
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  contains(c: string): boolean { return this.set.has(c); }
}

export class FakeElement extends FakeEventTarget {
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  className = '';
  textContent = '';
  isContentEditable = false;
  classList = new FakeClassList();
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  rect = { left: 0, top: 0, width: 800, height: 600 };
  pointerCaptures = new Set<number>();
  pointerLockRequests = 0;
  constructor(public readonly tagName: string, public ownerDocument: FakeDocument | null = null) { super(); }
  appendChild<T extends FakeElement>(c: T): T { c.remove(); c.parentNode = this; this.children.push(c); return c; }
  removeChild<T extends FakeElement>(c: T): T {
    const i = this.children.indexOf(c);
    if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; }
    return c;
  }
  remove(): void { this.parentNode?.removeChild(this); }
  contains(other: FakeElement | null): boolean {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  setAttribute(k: string, v: string): void { this.attributes.set(k, v); }
  getAttribute(k: string): string | null { return this.attributes.get(k) ?? null; }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number; x: number; y: number } {
    const r = this.rect;
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
  }
  setPointerCapture(id: number): void { this.pointerCaptures.add(id); }
  releasePointerCapture(id: number): void { this.pointerCaptures.delete(id); }
  hasPointerCapture(id: number): boolean { return this.pointerCaptures.has(id); }
  requestPointerLock(): Promise<void> {
    this.pointerLockRequests++;
    const doc = this.ownerDocument;
    if (doc) { doc.pointerLockElement = this; doc.dispatchEvent(new FakeEvent('pointerlockchange')); }
    return Promise.resolve();
  }
  /** Descendants (depth-first) matching a predicate. */
  findAll(pred: (e: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (e: FakeElement): void => { for (const c of e.children) { if (pred(c)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

export class FakeDocument extends FakeEventTarget {
  body: FakeElement;
  visibilityState: 'visible' | 'hidden' = 'visible';
  pointerLockElement: FakeElement | null = null;
  activeElement: FakeElement | null = null;
  constructor() { super(); this.body = new FakeElement('BODY', this); }
  createElement(tag: string): FakeElement { return new FakeElement(tag.toUpperCase(), this); }
  exitPointerLock(): void {
    if (!this.pointerLockElement) return;
    this.pointerLockElement = null;
    this.dispatchEvent(new FakeEvent('pointerlockchange'));
  }
}

export interface FakeButton { pressed: boolean; touched: boolean; value: number }

export class FakeGamepad {
  connected = true;
  timestamp = 0;
  axes: number[];
  buttons: FakeButton[];
  rumbles: Array<{ type: string; params: Record<string, number> }> = [];
  vibrationActuator: { playEffect(type: string, params: Record<string, number>): Promise<string> } | null;
  constructor(public id: string, public index: number, public mapping: '' | 'standard', nAxes = 4, nButtons = 17, rumble = true) {
    this.axes = new Array<number>(nAxes).fill(0);
    this.buttons = Array.from({ length: nButtons }, () => ({ pressed: false, touched: false, value: 0 }));
    this.vibrationActuator = rumble ? { playEffect: (type, params) => { this.rumbles.push({ type, params }); return Promise.resolve('complete'); } } : null;
  }
  setButton(i: number, value: number | boolean): void {
    const v = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    this.buttons[i] = { pressed: v > 0.5, touched: v > 0, value: v };
    this.timestamp++;
  }
  setAxis(i: number, v: number): void { this.axes[i] = v; this.timestamp++; }
}

export class FakeNavigator {
  pads: Array<FakeGamepad | null> = [];
  userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';
  maxTouchPoints = 0;
  getGamepads(): Array<FakeGamepad | null> { return this.pads.slice(); }
}

export class FakeWindow extends FakeEventTarget {
  innerWidth = 800;
  innerHeight = 600;
  constructor(public document: FakeDocument, public navigator: FakeNavigator) { super(); }
}

export class FakeStorage implements StorageLike {
  map = new Map<string, string>();
  fail = false;
  getItem(k: string): string | null { if (this.fail) throw new Error('blocked'); return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { if (this.fail) throw new Error('quota'); this.map.set(k, v); }
  removeItem(k: string): void { if (this.fail) throw new Error('blocked'); this.map.delete(k); }
}

export interface FakeDom {
  window: FakeWindow;
  document: FakeDocument;
  navigator: FakeNavigator;
  canvas: FakeElement;
  storage: FakeStorage;
  /** the fakes cast to DOM types for production constructors */
  env: { window: Window; document: Document; navigator: Navigator; storage: StorageLike; canvas: HTMLElement };
  keyDown(code: string, m?: Mods, target?: FakeElement): FakeKeyboardEvent;
  keyUp(code: string, m?: Mods, target?: FakeElement): FakeKeyboardEvent;
  /** keyDown + keyUp */
  tap(code: string, m?: Mods): void;
  pointer(type: string, init?: PointerInit, target?: FakeElement): FakePointerEvent;
  wheel(deltaY: number, deltaMode?: number): FakeWheelEvent;
  addPad(id: string, mapping: '' | 'standard', nAxes?: number, nButtons?: number): FakeGamepad;
  removePad(pad: FakeGamepad): void;
}

/** Builds a fresh fake browser environment with an 800×600 canvas attached to the body. */
export function makeFakeDom(): FakeDom {
  const document = new FakeDocument();
  const navigator = new FakeNavigator();
  const window = new FakeWindow(document, navigator);
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const storage = new FakeStorage();
  const key = (type: 'keydown' | 'keyup', code: string, m: Mods = {}, target?: FakeElement): FakeKeyboardEvent => {
    const e = new FakeKeyboardEvent(type, code, m);
    e.target = target ?? document.body;
    window.dispatchEvent(e);
    return e;
  };
  const dom: FakeDom = {
    window, document, navigator, canvas, storage,
    env: {
      window: window as unknown as Window, document: document as unknown as Document,
      navigator: navigator as unknown as Navigator, storage, canvas: canvas as unknown as HTMLElement,
    },
    keyDown: (code, m, target) => key('keydown', code, m, target),
    keyUp: (code, m, target) => key('keyup', code, m, target),
    tap: (code, m) => { key('keydown', code, m); key('keyup', code, m); },
    pointer: (type, init, target) => { const e = new FakePointerEvent(type, init); (target ?? canvas).dispatchEvent(e); return e; },
    wheel: (deltaY, deltaMode) => { const e = new FakeWheelEvent(deltaY, deltaMode); canvas.dispatchEvent(e); return e; },
    addPad: (id, mapping, nAxes, nButtons) => {
      let index = navigator.pads.findIndex((p) => p === null);
      if (index < 0) index = navigator.pads.length;
      const pad = new FakeGamepad(id, index, mapping, nAxes ?? (mapping === 'standard' ? 4 : 10), nButtons ?? (mapping === 'standard' ? 17 : 12));
      navigator.pads[index] = pad;
      const e = new FakeEvent('gamepadconnected') as FakeEvent & { gamepad: FakeGamepad };
      e.gamepad = pad;
      window.dispatchEvent(e);
      return pad;
    },
    removePad: (pad) => {
      pad.connected = false;
      navigator.pads[pad.index] = null;
      const e = new FakeEvent('gamepaddisconnected') as FakeEvent & { gamepad: FakeGamepad };
      e.gamepad = pad;
      window.dispatchEvent(e);
    },
  };
  return dom;
}
