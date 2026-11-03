/**
 * Pure navigation state for UiManager: the screen history stack (Esc = back in menus),
 * the Esc-key de-duplicator, and the rule for when the UI owns the keyboard.
 * No DOM access — unit-tested in Node.
 */
import type { ScreenId } from './screens/Screen';

/** Screens that start a fresh history (nothing to go back to below them). */
const ROOTS: ReadonlySet<ScreenId> = new Set<ScreenId>(['loading', 'main', 'flight']);

/**
 * Screen history. `navigate` pushes, except that roots reset the stack and navigating to a
 * screen already in the stack unwinds to it (so menus can never loop).
 */
export class ScreenRouter {
  private stack: ScreenId[];

  constructor(initial: ScreenId = 'loading') { this.stack = [initial]; }

  get current(): ScreenId { return this.stack[this.stack.length - 1]; }
  /** Number of entries in the history (1 = at a root). */
  get depth(): number { return this.stack.length; }
  /** The screen `back()` would return to, or null at a root. */
  get previous(): ScreenId | null { return this.stack.length > 1 ? this.stack[this.stack.length - 2] : null; }

  /** Returns true when the current screen changed. */
  navigate(id: ScreenId): boolean {
    if (id === this.current) return false;
    if (ROOTS.has(id)) { this.stack = [id]; return true; }
    const i = this.stack.indexOf(id);
    if (i >= 0) { this.stack.length = i + 1; return true; }
    this.stack.push(id);
    return true;
  }

  /**
   * Esc / back button. Returns the new current screen, or null when there is nothing to go
   * back to (loading screen, the flight itself, or the main menu before any flight).
   * A root menu other than 'main' falls back to the flight (if one is loaded) or the main menu.
   */
  back(inFlight: boolean): ScreenId | null {
    if (this.stack.length > 1) { this.stack.pop(); return this.current; }
    const c = this.current;
    if (c === 'loading' || c === 'flight') return null;
    if (c === 'main') { if (!inFlight) return null; this.stack = ['flight']; return 'flight'; }
    this.stack = [inFlight ? 'flight' : 'main'];
    return this.current;
  }

  /** Copy of the history (to restore after a failed spawn). */
  save(): ScreenId[] { return this.stack.slice(); }
  restore(stack: readonly ScreenId[]): void { this.stack = stack.length ? stack.slice() : ['main']; }
}

/**
 * The UI handles Esc itself (the input module ignores keys while a menu has captured the
 * keyboard or a text field has focus). When the keyboard is *not* captured the input module
 * also reports the same press as a 'toggleMenu' action a frame later; this swallows that echo
 * while still letting a gamepad Start/Menu button (no keydown) through.
 */
export class EscapeDeduper {
  private pending = 0;
  private lastMs = -Infinity;
  constructor(private readonly windowMs = 600) {}

  /** The UI just handled an Esc keydown at `nowMs`. */
  noteKey(nowMs: number): void {
    if (nowMs - this.lastMs > this.windowMs) this.pending = 0;
    this.pending++;
    this.lastMs = nowMs;
  }

  /** True when a 'toggleMenu' action at `nowMs` is the echo of an Esc key already handled. */
  isEcho(nowMs: number): boolean {
    if (this.pending > 0 && nowMs - this.lastMs <= this.windowMs) { this.pending--; return true; }
    this.pending = 0;
    return false;
  }
}

export interface CaptureState {
  route: ScreenId;
  /** pause menu, help sheet, landing report or another modal is open in flight */
  overlayOpen: boolean;
  /** a text-like input (text, search, number, textarea, select) has focus */
  textFocus: boolean;
}

/** The UI owns the keyboard in every menu, while an in-flight overlay is open, or while typing. */
export function shouldCaptureInput(s: CaptureState): boolean {
  return s.route !== 'flight' || s.overlayOpen || s.textFocus;
}

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(['text', 'search', 'number', 'email', 'password', 'url', 'tel']);

/** Element-like check used by the focus tracker (duck-typed so it is testable without a DOM). */
export function isTextEntry(el: { tagName?: unknown; type?: unknown; isContentEditable?: unknown } | null | undefined): boolean {
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(String(el.type ?? 'text').toLowerCase());
  return el.isContentEditable === true;
}

const RELEASE_ON_CLICK_INPUTS: ReadonlySet<string> = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color']);
const RELEASE_ROLES: ReadonlySet<string> = new Set(['button', 'checkbox', 'switch', 'option', 'tab', 'radio', 'menuitem']);

/**
 * In flight the keyboard flies the aircraft, so a control used with the pointer in the toolbar or
 * a floating panel must not keep the focus: the input module ignores every key whose target is an
 * INPUT or SELECT (a focused slider or dropdown silently disables the flight keys), and a focused
 * button or checklist row re-activates on Space/Enter. True when `el` should be blurred after a
 * pointer `click` or a committed `change`. Text fields keep the focus while being clicked (typing).
 * Duck-typed so it is testable without a DOM.
 */
export function releasesFocusAfter(
  el: { tagName?: unknown; type?: unknown; getAttribute?: (name: string) => string | null } | null | undefined,
  ev: 'click' | 'change',
): boolean {
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (ev === 'change') return tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA';
  if (tag === 'BUTTON') return true;
  if (tag === 'INPUT') return RELEASE_ON_CLICK_INPUTS.has(String(el.type ?? 'text').toLowerCase());
  if (tag === 'SELECT' || tag === 'TEXTAREA') return false; // a click opens the dropdown / places the caret
  const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
  return role !== null && RELEASE_ROLES.has(role);
}
