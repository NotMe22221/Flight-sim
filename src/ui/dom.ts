/** Tiny DOM helpers: hyperscript, change-only text cells, common controls. */
import { ICONS, type IconName } from './icons';

export type Child = Node | string | number | null | undefined | false | Child[];

export interface Attrs {
  class?: string;
  id?: string;
  text?: string;
  html?: string;
  title?: string;
  type?: string;
  value?: string | number;
  placeholder?: string;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  disabled?: boolean;
  checked?: boolean;
  tabIndex?: number;
  role?: string;
  href?: string;
  target?: string;
  rel?: string;
  htmlFor?: string;
  style?: string;
  autocomplete?: string;
  spellcheck?: boolean;
  dataset?: Record<string, string>;
  aria?: Record<string, string | boolean>;
  onClick?: (e: MouseEvent) => void;
  onInput?: (e: Event) => void;
  onChange?: (e: Event) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
}

function append(parent: Node, c: Child): void {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) { for (const x of c) append(parent, x); return; }
  if (c instanceof Node) { parent.appendChild(c); return; }
  parent.appendChild(document.createTextNode(String(c)));
}

/** h('div', { class: 'x', onClick }, 'text', child, [more]) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    if (attrs.class) el.className = attrs.class;
    if (attrs.id) el.id = attrs.id;
    if (attrs.text !== undefined) el.textContent = attrs.text;
    if (attrs.html !== undefined) el.innerHTML = attrs.html;
    if (attrs.title) el.title = attrs.title;
    if (attrs.role) el.setAttribute('role', attrs.role);
    if (attrs.tabIndex !== undefined) el.tabIndex = attrs.tabIndex;
    if (attrs.style) el.setAttribute('style', attrs.style);
    if (attrs.dataset) for (const [k, v] of Object.entries(attrs.dataset)) el.dataset[k] = v;
    if (attrs.aria) for (const [k, v] of Object.entries(attrs.aria)) el.setAttribute(`aria-${k}`, String(v));
    const anyEl = el as unknown as Record<string, unknown>;
    for (const k of ['type', 'value', 'placeholder', 'min', 'max', 'step', 'disabled', 'checked', 'href', 'target', 'rel', 'htmlFor', 'autocomplete', 'spellcheck'] as const) {
      if (attrs[k] !== undefined) anyEl[k] = attrs[k];
    }
    if (attrs.onClick) el.addEventListener('click', attrs.onClick as EventListener);
    if (attrs.onInput) el.addEventListener('input', attrs.onInput);
    if (attrs.onChange) el.addEventListener('change', attrs.onChange);
    if (attrs.onKeyDown) el.addEventListener('keydown', attrs.onKeyDown as EventListener);
  }
  for (const c of children) append(el, c);
  return el;
}

export function clear(el: Element): void { while (el.firstChild) el.removeChild(el.firstChild); }

export function icon(name: IconName, cls = ''): HTMLElement {
  const s = h('span', { class: `icon${cls ? ' ' + cls : ''}` });
  s.innerHTML = ICONS[name];
  return s;
}

/** Writes textContent only when the value changes (DOM writes are the per-frame cost). */
export class Txt {
  private last: string | null = null;
  constructor(public readonly el: HTMLElement, initial?: string) { if (initial !== undefined) this.set(initial); }
  set(v: string): void { if (v !== this.last) { this.last = v; this.el.textContent = v; } }
  get value(): string { return this.last ?? ''; }
}

/** Toggles a class only when the state changes. */
export class Cls {
  private last: boolean | null = null;
  constructor(public readonly el: HTMLElement, private readonly cls: string) {}
  set(on: boolean): void { if (on !== this.last) { this.last = on; this.el.classList.toggle(this.cls, on); } }
}

export interface ButtonOpts { icon?: IconName; cls?: string; title?: string; primary?: boolean; big?: boolean; disabled?: boolean; aria?: Record<string, string | boolean> }
export function button(label: string, onClick: (e: MouseEvent) => void, o: ButtonOpts = {}): HTMLButtonElement {
  const cls = ['btn', o.primary ? 'btn-primary' : '', o.big ? 'btn-big' : '', o.cls ?? ''].filter(Boolean).join(' ');
  const b = h('button', { class: cls, type: 'button', title: o.title, onClick, disabled: o.disabled, aria: o.aria });
  if (o.icon) b.appendChild(icon(o.icon));
  if (label) b.appendChild(h('span', { class: 'btn-label', text: label }));
  return b;
}

/** Thin uppercase section label. */
export function sectionLabel(text: string, cls = ''): HTMLElement { return h('div', { class: `section-label ${cls}`.trim(), text }); }

export interface SelectOpt<T extends string> { value: T; label: string }
export function select<T extends string>(options: SelectOpt<T>[], value: T, onChange: (v: T) => void, cls = ''): HTMLSelectElement {
  const s = h('select', { class: `select ${cls}`.trim() });
  for (const o of options) s.appendChild(h('option', { value: o.value, text: o.label }));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}

export interface SliderOpts { min: number; max: number; step: number; value: number; label?: string; format?: (v: number) => string; onInput: (v: number) => void; onChange?: (v: number) => void }
export interface SliderHandle { el: HTMLElement; input: HTMLInputElement; set(v: number): void; readout: Txt }
export function slider(o: SliderOpts): SliderHandle {
  const input = h('input', { type: 'range', min: o.min, max: o.max, step: o.step, value: o.value, class: 'slider' });
  const readout = new Txt(h('span', { class: 'slider-readout' }), o.format ? o.format(o.value) : String(o.value));
  const row = h('div', { class: 'slider-row' }, o.label ? h('span', { class: 'slider-label', text: o.label }) : null, input, readout.el);
  input.addEventListener('input', () => { const v = parseFloat(input.value); readout.set(o.format ? o.format(v) : String(v)); o.onInput(v); });
  if (o.onChange) input.addEventListener('change', () => o.onChange!(parseFloat(input.value)));
  return { el: row, input, readout, set: (v) => { input.value = String(v); readout.set(o.format ? o.format(v) : String(v)); } };
}

export interface ToggleHandle { el: HTMLElement; set(v: boolean): void; get(): boolean }
export function toggle(label: string, value: boolean, onChange: (v: boolean) => void, help?: string): ToggleHandle {
  const knob = h('span', { class: 'toggle-knob' });
  const sw = h('button', { class: `toggle${value ? ' on' : ''}`, type: 'button', role: 'switch', aria: { checked: value } }, knob);
  let state = value;
  const set = (v: boolean) => { state = v; sw.classList.toggle('on', v); sw.setAttribute('aria-checked', String(v)); };
  sw.addEventListener('click', () => { set(!state); onChange(state); });
  const row = h('label', { class: 'toggle-row', title: help },
    h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label', text: label }), help ? h('span', { class: 'toggle-help', text: help }) : null),
    sw);
  return { el: row, set, get: () => state };
}

/** Segmented control (exclusive buttons). */
export interface SegmentedHandle<T extends string> { el: HTMLElement; set(v: T | null): void }
export function segmented<T extends string>(options: SelectOpt<T>[], value: T | null, onChange: (v: T) => void, cls = ''): SegmentedHandle<T> {
  const buttons = new Map<T, HTMLButtonElement>();
  const el = h('div', { class: `segmented ${cls}`.trim(), role: 'group' });
  const set = (v: T | null) => { for (const [k, b] of buttons) { b.classList.toggle('active', k === v); b.setAttribute('aria-pressed', String(k === v)); } };
  for (const o of options) {
    const b = h('button', { class: 'seg', type: 'button', text: o.label, onClick: () => { set(o.value); onChange(o.value); } });
    buttons.set(o.value, b);
    el.appendChild(b);
  }
  set(value);
  return { el, set };
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
}

export function clampNum(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

/** Simple keyboard navigation inside a menu: ↑/↓ moves focus among focusable children, Enter activates. */
export function arrowNavigation(root: HTMLElement, selector = 'button:not([disabled]), [tabindex="0"], input, select'): void {
  root.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'range')) return;
    if (t && (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text'))) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((x) => x.offsetParent !== null);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus();
    e.preventDefault();
  });
}

/** Device badge icon for bindings. */
export function deviceIcon(device: 'keyboard' | 'gamepad' | 'mouse' | 'none'): HTMLElement {
  const el = icon(device === 'gamepad' ? 'gamepad' : device === 'mouse' ? 'mouse' : 'keyboard', 'device-icon');
  if (device === 'none') el.style.visibility = 'hidden'; // unbound: keep the column aligned, show no device
  return el;
}

/** 'engineAutoStart' → 'Engine auto start' */
export function humanizeAction(action: string): string {
  const s = action.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1)
    .replace(/\bap\b/g, 'AP').replace(/\bfd\b/g, 'FD').replace(/\bhdg\b/g, 'HDG').replace(/\bnav\b/g, 'NAV').replace(/\bapr\b/g, 'APR')
    .replace(/\balt\b/g, 'ALT').replace(/\bvs\b/g, 'VS').replace(/\bflc\b/g, 'FLC').replace(/\blvl\b/g, 'LVL').replace(/\bias\b/g, 'IAS')
    .replace(/\bobs\b/g, 'OBS').replace(/\batc\b/g, 'ATC').replace(/\bcom\b/g, 'COM').replace(/\bhud\b/g, 'HUD').replace(/\bstd\b/g, 'STD');
}

/**
 * True on touch-first devices (no hover, coarse pointer). Text fields are not auto-focused there:
 * focusing one pops up the on-screen keyboard over half of the screen.
 */
export function isCoarsePointer(): boolean {
  try { return typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches; } catch { return false; }
}
