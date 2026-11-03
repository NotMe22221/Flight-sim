/** Screen base class and the context every screen receives from UiManager. */
import type { UiHost } from '../UiHost';
import type { SimSnapshot } from '../../core/types';
import type { SelectionStore } from '../selection';
import type { PersistedSettings } from '../settingsStore';
import { button, h } from '../dom';

export type ScreenId = 'loading' | 'main' | 'worldmap' | 'aircraft' | 'weather' | 'settings' | 'credits' | 'activities' | 'flight';

export interface ScreenContext {
  host: UiHost;
  selection: SelectionStore;
  settings(): PersistedSettings;
  /** Saves and pushes changed groups to the host. */
  applySettings(patch: Partial<Omit<PersistedSettings, 'version'>>): void;
  navigate(id: ScreenId): void;
  back(): void;
  /** Start a flight with the current selection. */
  fly(): void;
  inFlight(): boolean;
  toast(text: string, kind?: 'info' | 'warn' | 'error' | 'success', durationMs?: number): void;
  /** Forgets persisted floating-panel positions. */
  resetLayout?(): void;
  /** Activities: show the loading screen and start a landing challenge (host.startChallenge). */
  startChallenge?(id: string): void;
  /** Activities › Flight training: loading screen, host.startLesson(id), then the flight view. */
  startLesson?(id: string): void;
  /** Activities › Bush trips: loading screen, host.startBushLeg(tripId, legIndex), then the flight view. */
  startBushLeg?(tripId: string, legIndex: number): void;
  /** Debrief "Retry" / pause menu "Restart activity": loading screen, host.restartActivity(), then the flight view. */
  restartActivity?(): void;
  /** Main menu "Resume flight": back to the flight and out of the pause menu (Esc/back keeps it open). */
  resumeFlight?(): void;
}

export abstract class Screen {
  readonly el: HTMLElement;
  private _visible = false;
  constructor(cls: string, overlay = false) {
    this.el = h('section', { class: `screen ${cls}${overlay ? ' overlay' : ''}`, aria: { hidden: true } });
    setInert(this.el, true);
  }
  get visible(): boolean { return this._visible; }
  show(): void { if (this._visible) return; this._visible = true; this.el.classList.add('visible'); this.el.setAttribute('aria-hidden', 'false'); setInert(this.el, false); this.onShow(); }
  /**
   * A hidden screen only fades out (opacity), so it must also leave the tab order: Tab pressed in
   * flight would otherwise land in an invisible menu (an invisible search box then owns the keyboard).
   */
  hide(): void { if (!this._visible) return; this._visible = false; this.el.classList.remove('visible'); this.el.setAttribute('aria-hidden', 'true'); setInert(this.el, true); this.onHide(); }
  protected onShow(): void { /* override */ }
  protected onHide(): void { /* override */ }
  /** Per-frame update while visible. */
  update(_s: SimSnapshot, _nowMs: number): void { /* override */ }
  /** Return true when the key was consumed. */
  onKey(_e: KeyboardEvent): boolean { return false; }
  /** Focus the first meaningful control. */
  focus(): void { (this.el.querySelector<HTMLElement>('input, button:not([disabled])') ?? this.el).focus(); }
  /** Release timers, observers and subscriptions (UiManager.dispose). */
  dispose(): void { /* override */ }
}

/** `inert` where supported (no focus, no clicks); the CSS also sets visibility: hidden on hidden screens. */
function setInert(el: HTMLElement, on: boolean): void {
  if ('inert' in el) (el as HTMLElement & { inert: boolean }).inert = on;
}

export function screenHeader(ctx: ScreenContext, title: string, subtitle?: string, ...extra: HTMLElement[]): HTMLElement {
  return h('header', { class: 'screen-header' },
    button('', () => ctx.back(), { icon: 'back', cls: 'btn-ghost btn-icon', title: 'Back (Esc)', aria: { label: 'Back' } }),
    h('h1', { class: 'screen-title', text: title }),
    subtitle ? h('span', { class: 'screen-subtitle', text: subtitle }) : null,
    h('span', { class: 'spacer' }),
    ...extra);
}
