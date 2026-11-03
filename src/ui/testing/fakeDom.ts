/**
 * TEST ONLY: a small in-memory DOM so the UI's DOM classes (FlightUi, the Activities tabs, the
 * debrief …) can be driven in Node by vitest (environment 'node', no jsdom in this project).
 *
 * It implements what src/ui uses: elements and text nodes, class lists, inline styles, attributes
 * and dataset, bubbling events with capture listeners, focus, a selector engine for tag / .class /
 * #id / [attr] / [attr="v"] / :not(...) with descendant combinators and comma lists, and permissive
 * canvas contexts. Layout is not modelled (sizes are 0); an element counts as rendered when it is in
 * the document and no ancestor has `style.display = 'none'`.
 *
 * `installFakeDom()` sets the globals and returns a function that removes them again.
 */

type Listener = { fn: (e: FakeEvent) => void; capture: boolean };

/**
 * DOM write calls since the last reset (text, HTML, class, attributes, inline styles, dataset,
 * inserted / removed nodes; same-value writes count too): tests check that steady frames write nothing.
 */
export const domWrites = { count: 0 };

export class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  target: FakeEventTarget | null = null;
  currentTarget: FakeEventTarget | null = null;
  defaultPrevented = false;
  stopped = false;
  readonly isTrusted = true;
  key = '';
  code = '';
  detail = 0;
  shiftKey = false; altKey = false; ctrlKey = false; metaKey = false; repeat = false;
  clientX = 0; clientY = 0; pointerId = 1;
  relatedTarget: FakeEventTarget | null = null;
  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== false;
    Object.assign(this, init);
  }
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.stopped = true; }
  stopImmediatePropagation(): void { this.stopped = true; }
}

export class FakeEventTarget {
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: (e: FakeEvent) => void, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const l = this.listeners.get(type) ?? [];
    if (!l.some((x) => x.fn === fn && x.capture === capture)) l.push({ fn, capture });
    this.listeners.set(type, l);
  }
  removeEventListener(type: string, fn: (e: FakeEvent) => void, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const l = this.listeners.get(type);
    if (l) this.listeners.set(type, l.filter((x) => !(x.fn === fn && x.capture === capture)));
  }
  /** listener count (tests check that nothing is left subscribed) */
  listenerCount(type?: string): number {
    if (type) return this.listeners.get(type)?.length ?? 0;
    let n = 0; for (const l of this.listeners.values()) n += l.length; return n;
  }
  invoke(e: FakeEvent, capture: boolean): void {
    for (const l of [...(this.listeners.get(e.type) ?? [])]) {
      if (l.capture !== capture) continue;
      e.currentTarget = this;
      l.fn.call(this, e);
    }
  }
  /** parent in the event path */
  eventParent(): FakeEventTarget | null { return null; }
  dispatchEvent(e: FakeEvent): boolean {
    e.target = this;
    const path: FakeEventTarget[] = [];
    for (let n: FakeEventTarget | null = this; n; n = n.eventParent()) path.push(n);
    for (let i = path.length - 1; i > 0 && !e.stopped; i--) path[i].invoke(e, true);
    if (!e.stopped) { this.invoke(e, true); this.invoke(e, false); }
    if (e.bubbles) for (let i = 1; i < path.length && !e.stopped; i++) path[i].invoke(e, false);
    return !e.defaultPrevented;
  }
}

export class FakeNode extends FakeEventTarget {
  parentNode: FakeElement | null = null;
  readonly childNodes: FakeNode[] = [];
  ownerDocument: FakeDocument | null = null;
  get parentElement(): FakeElement | null { return this.parentNode; }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get isConnected(): boolean {
    let n: FakeNode | null = this;
    while (n.parentNode) n = n.parentNode;
    return n instanceof FakeElement && n.tagName === 'HTML';
  }
  override eventParent(): FakeEventTarget | null {
    if (this.parentNode) return this.parentNode;
    // the root <html> element bubbles to the document, the document to the window
    return this instanceof FakeElement && this.tagName === 'HTML' ? fake.document : null;
  }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) {
    domWrites.count++;
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (v !== '' && v !== null && v !== undefined) this.appendChild(new FakeText(String(v)));
  }
  appendChild<T extends FakeNode>(c: T): T { return this.insertBefore(c, null); }
  insertBefore<T extends FakeNode>(c: T, ref: FakeNode | null): T {
    domWrites.count++;
    if ((c as FakeNode) === this) throw new Error('cannot append a node to itself');
    c.remove();
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i >= 0) this.childNodes.splice(i, 0, c); else this.childNodes.push(c);
    c.parentNode = this as unknown as FakeElement;
    return c;
  }
  removeChild<T extends FakeNode>(c: T): T {
    domWrites.count++;
    const i = this.childNodes.indexOf(c);
    if (i < 0) throw new Error('not a child');
    this.childNodes.splice(i, 1);
    c.parentNode = null;
    const d = fake.document;
    if (d && d.activeElement && (d.activeElement === (c as unknown) || c.contains(d.activeElement))) d.activeElement = d.body;
    return c;
  }
  remove(): void { this.parentNode?.removeChild(this); }
  append(...cs: (FakeNode | string)[]): void { for (const c of cs) this.appendChild(typeof c === 'string' ? new FakeText(c) : c); }
  prepend(...cs: (FakeNode | string)[]): void {
    const first = this.firstChild;
    for (const c of cs) this.insertBefore(typeof c === 'string' ? new FakeText(c) : c, first);
  }
  replaceChildren(...cs: (FakeNode | string)[]): void { for (const c of [...this.childNodes]) this.removeChild(c); this.append(...cs); }
  contains(o: unknown): boolean {
    for (let n = o as FakeNode | null; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
}

export class FakeText extends FakeNode {
  constructor(public data: string) { super(); }
  override get textContent(): string { return this.data; }
  override set textContent(v: string) { domWrites.count++; this.data = String(v); }
}

const camel = (k: string): string => k.trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

class FakeStyle {
  [k: string]: unknown;
  setProperty(k: string, v: string): void { this[k.startsWith('--') ? k : camel(k)] = String(v); }
  removeProperty(k: string): void { delete this[k.startsWith('--') ? k : camel(k)]; }
  getPropertyValue(k: string): string { const v = this[k.startsWith('--') ? k : camel(k)]; return typeof v === 'string' ? v : ''; }
}

class FakeClassList {
  constructor(private readonly el: FakeElement) {}
  private get list(): string[] { return this.el.className.split(/\s+/).filter(Boolean); }
  private set list(v: string[]) { this.el.className = v.join(' '); }
  contains(c: string): boolean { return this.list.includes(c); }
  add(...cs: string[]): void { const l = this.list; for (const c of cs) if (!l.includes(c)) l.push(c); this.list = l; }
  remove(...cs: string[]): void { this.list = this.list.filter((x) => !cs.includes(x)); }
  toggle(c: string, force?: boolean): boolean {
    const on = force ?? !this.contains(c);
    if (on) this.add(c); else this.remove(c);
    return on;
  }
  get length(): number { return this.list.length; }
}

/** Permissive 2D/WebGL context: every method is a no-op, every property settable. */
function permissiveContext(canvas: FakeElement): unknown {
  const store: Record<string | symbol, unknown> = { canvas };
  return new Proxy(store, {
    get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 0 }) : k === 'getImageData' || k === 'createImageData' ? () => ({ data: new Uint8ClampedArray(4) }) : () => undefined),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}

export class FakeElement extends FakeNode {
  readonly tagName: string;
  private cls = '';
  get className(): string { return this.cls; }
  set className(v: string) { domWrites.count++; this.cls = String(v); }
  readonly style: FakeStyle = new Proxy(new FakeStyle(), { set: (t, k, v) => { domWrites.count++; (t as unknown as Record<string | symbol, unknown>)[k] = v; return true; } });
  readonly dataset: Record<string, string> = new Proxy({} as Record<string, string>, { set: (t, k, v) => { domWrites.count++; t[k as string] = String(v); return true; } });
  readonly classList = new FakeClassList(this);
  private attrs = new Map<string, string>();
  private html = '';
  [k: string]: unknown;
  constructor(tag: string) { super(); this.tagName = tag.toUpperCase(); }

  get id(): string { return this.attrs.get('id') ?? ''; }
  set id(v: string) { domWrites.count++; this.attrs.set('id', String(v)); }
  get tabIndex(): number { const v = this.attrs.get('tabindex'); return v === undefined ? (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(this.tagName) ? 0 : -1) : Number(v); }
  set tabIndex(v: number) { domWrites.count++; this.attrs.set('tabindex', String(v)); }
  get disabled(): boolean { return this.attrs.has('disabled'); }
  set disabled(v: boolean) { domWrites.count++; if (v) this.attrs.set('disabled', ''); else this.attrs.delete('disabled'); }
  get title(): string { return this.attrs.get('title') ?? ''; }
  set title(v: string) { domWrites.count++; this.attrs.set('title', String(v)); }
  get innerHTML(): string { return this.childNodes.length ? this.textContent : this.html; }
  set innerHTML(v: string) { this.textContent = ''; this.html = String(v); }
  override get textContent(): string { return super.textContent; }
  override set textContent(v: string) { this.html = ''; super.textContent = v; }
  get children(): FakeElement[] { return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement); }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get lastElementChild(): FakeElement | null { const c = this.children; return c[c.length - 1] ?? null; }
  get childElementCount(): number { return this.children.length; }
  private sibling(d: number): FakeElement | null {
    const s = this.parentNode?.children ?? [];
    return s[s.indexOf(this) + d] ?? null;
  }
  get nextElementSibling(): FakeElement | null { return this.sibling(1); }
  get previousElementSibling(): FakeElement | null { return this.sibling(-1); }

  setAttribute(k: string, v: string): void {
    domWrites.count++;
    const key = k.toLowerCase();
    if (key === 'class') { this.className = String(v); return; }
    if (key === 'style') { for (const part of String(v).split(';')) { const i = part.indexOf(':'); if (i > 0) this.style.setProperty(part.slice(0, i).trim(), part.slice(i + 1).trim()); } return; }
    if (key.startsWith('data-')) { this.dataset[camel(key.slice(5))] = String(v); return; }
    this.attrs.set(key, String(v));
  }
  getAttribute(k: string): string | null {
    const key = k.toLowerCase();
    if (key === 'class') return this.className || null;
    if (key.startsWith('data-')) { const v = this.dataset[camel(key.slice(5))]; return v === undefined ? null : v; }
    return this.attrs.get(key) ?? null;
  }
  hasAttribute(k: string): boolean { return this.getAttribute(k) !== null; }
  removeAttribute(k: string): void {
    domWrites.count++;
    const key = k.toLowerCase();
    if (key === 'class') this.className = '';
    else if (key.startsWith('data-')) delete this.dataset[camel(key.slice(5))];
    else this.attrs.delete(key);
  }
  toggleAttribute(k: string, force?: boolean): boolean {
    const on = force ?? !this.hasAttribute(k);
    if (on) this.setAttribute(k, ''); else this.removeAttribute(k);
    return on;
  }

  /** In the document and not under an element with an inline `display: none`. */
  get rendered(): boolean {
    if (!this.isConnected) return false;
    for (let n: FakeElement | null = this; n; n = n.parentNode) if (n.style.display === 'none') return false;
    return true;
  }
  get offsetParent(): FakeElement | null { return this.rendered ? fake.document!.body : null; }
  get offsetWidth(): number { return 0; }
  get offsetHeight(): number { return 0; }
  get clientWidth(): number { return 0; }
  get clientHeight(): number { return 0; }
  scrollTop = 0; scrollLeft = 0;
  get scrollHeight(): number { return 0; }
  getClientRects(): { width: number; height: number }[] { return this.rendered ? [{ width: 1, height: 1 }] : []; }
  getBoundingClientRect(): { x: number; y: number; left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  scrollIntoView(): void { /* no layout */ }
  setPointerCapture(): void { /* no-op */ }
  releasePointerCapture(): void { /* no-op */ }
  getContext(): unknown { return permissiveContext(this); }

  focus(): void {
    const d = fake.document!;
    if (this.disabled || !this.isConnected || d.activeElement === this) return;
    const prev = d.activeElement;
    d.activeElement = this;
    if (prev && prev !== d.body) prev.dispatchEvent(new FakeEvent('focusout', { relatedTarget: this }));
    this.dispatchEvent(new FakeEvent('focusin', { relatedTarget: prev }));
  }
  blur(): void {
    const d = fake.document!;
    if (d.activeElement !== this) return;
    d.activeElement = d.body;
    this.dispatchEvent(new FakeEvent('focusout', { relatedTarget: null }));
  }
  /** A user click: ignored on a disabled control, like a browser. */
  click(): void { if (!this.disabled) this.dispatchEvent(new FakeEvent('click', { detail: 1 })); }

  matches(sel: string): boolean { return matchesSelector(this, sel); }
  closest(sel: string): FakeElement | null {
    for (let n: FakeElement | null = this; n; n = n.parentNode) if (matchesSelector(n, sel)) return n;
    return null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeNode) => { for (const c of n.childNodes) if (c instanceof FakeElement) { if (matchesSelector(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeElement | null { return this.querySelectorAll(sel)[0] ?? null; }
}

// ─── selectors: tag, .class, #id, [attr], [attr="v"], :not(compound), descendant ' ', ',' ──────────

interface Compound { tag: string | null; classes: string[]; id: string | null; attrs: { k: string; v: string | null }[]; nots: Compound[] }

function parseCompound(s: string): Compound {
  const c: Compound = { tag: null, classes: [], id: null, attrs: [], nots: [] };
  let i = 0;
  const ident = (): string => { const m = /^[-\w]+/.exec(s.slice(i)); if (!m) throw new Error(`bad selector ${s}`); i += m[0].length; return m[0]; };
  if (/^[a-zA-Z*]/.test(s)) { if (s[0] === '*') i = 1; else c.tag = ident().toUpperCase(); }
  while (i < s.length) {
    const ch = s[i];
    if (ch === '.') { i++; c.classes.push(ident()); }
    else if (ch === '#') { i++; c.id = ident(); }
    else if (ch === '[') {
      const end = s.indexOf(']', i);
      const body = s.slice(i + 1, end);
      const eq = body.indexOf('=');
      c.attrs.push(eq < 0 ? { k: body.trim().toLowerCase(), v: null } : { k: body.slice(0, eq).trim().toLowerCase(), v: body.slice(eq + 1).trim().replace(/^["']|["']$/g, '') });
      i = end + 1;
    } else if (s.startsWith(':not(', i)) {
      let depth = 0, j = i + 4;
      for (; j < s.length; j++) { if (s[j] === '(') depth++; else if (s[j] === ')' && --depth === 0) break; }
      c.nots.push(parseCompound(s.slice(i + 5, j)));
      i = j + 1;
    } else throw new Error(`unsupported selector "${s}"`);
  }
  return c;
}

function matchCompound(el: FakeElement, c: Compound): boolean {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id !== null && el.id !== c.id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const a of c.attrs) { const v = el.getAttribute(a.k); if (v === null || (a.v !== null && v !== a.v)) return false; }
  for (const n of c.nots) if (matchCompound(el, n)) return false;
  return true;
}

const cache = new Map<string, Compound[][]>();
function parseSelector(sel: string): Compound[][] {
  let p = cache.get(sel);
  if (!p) {
    p = sel.split(',').map((part) => part.trim().replace(/\s*>\s*/g, ' ').split(/\s+(?![^[]*\])/).filter(Boolean).map(parseCompound));
    cache.set(sel, p);
  }
  return p;
}

function matchesSelector(el: FakeElement, sel: string): boolean {
  return parseSelector(sel).some((chain) => {
    if (!matchCompound(el, chain[chain.length - 1])) return false;
    let k = chain.length - 2;
    for (let n = el.parentNode; n && k >= 0; n = n.parentNode) if (matchCompound(n, chain[k])) k--;
    return k < 0;
  });
}

// ─── document, window, install ──────────────────────────────────────────────────────────────

export class FakeDocument extends FakeEventTarget {
  readonly documentElement = new FakeElement('html');
  readonly body = new FakeElement('body');
  activeElement: FakeElement;
  constructor() {
    super();
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  override eventParent(): FakeEventTarget | null { return fake.window; }
  createElement(tag: string): FakeElement { const e = new FakeElement(tag); e.ownerDocument = this; return e; }
  createTextNode(t: string): FakeText { return new FakeText(t); }
  querySelector(sel: string): FakeElement | null { return this.documentElement.querySelector(sel); }
  querySelectorAll(sel: string): FakeElement[] { return this.documentElement.querySelectorAll(sel); }
  getElementById(id: string): FakeElement | null { return this.documentElement.querySelector(`#${id}`); }
  hasFocus(): boolean { return true; }
}

export class FakeWindow extends FakeEventTarget {
  innerWidth = 1280;
  innerHeight = 720;
  devicePixelRatio = 1;
}

class MemoryStorage {
  private m = new Map<string, string>();
  get length(): number { return this.m.size; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
}

const fake: { document: FakeDocument | null; window: FakeWindow | null } = { document: null, window: null };

export interface FakeDomHandle {
  document: FakeDocument;
  window: FakeWindow;
  /** removes the globals again */
  uninstall(): void;
}

/** Installs `document`, `window`, `Node`, `HTMLElement`, `localStorage` … as globals (test files only). */
export function installFakeDom(opts: { width?: number; height?: number } = {}): FakeDomHandle {
  const g = globalThis as Record<string, unknown>;
  const doc = new FakeDocument();
  const win = new FakeWindow();
  win.innerWidth = opts.width ?? 1280;
  win.innerHeight = opts.height ?? 720;
  fake.document = doc;
  fake.window = win;
  const storage = new MemoryStorage();
  const media = (q: string) => ({ matches: false, media: q, addEventListener() { /* */ }, removeEventListener() { /* */ }, addListener() { /* */ }, removeListener() { /* */ } });
  const globals: Record<string, unknown> = {
    document: doc,
    window: win,
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeElement,
    Text: FakeText,
    Event: FakeEvent,
    CustomEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
    localStorage: storage,
    matchMedia: media,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    ResizeObserver: class { observe(): void { /* */ } unobserve(): void { /* */ } disconnect(): void { /* */ } },
    getComputedStyle: (el: FakeElement) => el.style,
  };
  Object.assign(win, { document: doc, localStorage: storage, matchMedia: media, getComputedStyle: globals.getComputedStyle });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [k, v] of Object.entries(globals)) {
    saved.set(k, Object.getOwnPropertyDescriptor(g, k));
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  }
  return {
    document: doc,
    window: win,
    uninstall() {
      for (const [k, d] of saved) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
      fake.document = null;
      fake.window = null;
    },
  };
}

/** Every element under `root` whose text contains `text` and that matches `sel` (default: buttons). */
export function byText(root: { querySelectorAll(sel: string): FakeElement[] }, text: string, sel = 'button'): FakeElement[] {
  return root.querySelectorAll(sel).filter((e) => e.textContent.includes(text));
}

/** The one rendered button whose label contains `text` (throws when there is none). */
export function buttonByText(root: { querySelectorAll(sel: string): FakeElement[] }, text: string): FakeElement {
  const b = byText(root, text).find((e) => e.rendered);
  if (!b) throw new Error(`no visible button "${text}"`);
  return b;
}
