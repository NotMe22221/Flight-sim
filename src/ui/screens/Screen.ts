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
  toast(text: string, kind?: 'info' | 'warn' | 'error' | 'success'): void;
  /** Forgets persisted floating-panel positions. */
  resetLayout?(): void;
  /** Activities: show the loading screen and start a landing challenge (host.startChallenge). */
  startChallenge?(id: string): void;
}

export abstract class Screen {
  readonly el: HTMLElement;
  private _visible = false;
  constructor(cls: string, overlay = false) { this.el = h('section', { class: `screen ${cls}${overlay ? ' overlay' : ''}`, aria: { hidden: true } }); }
  get visible(): boolean { return this._visible; }
  show(): void { if (this._visible) return; this._visible = true; this.el.classList.add('visible'); this.el.setAttribute('aria-hidden', 'false'); this.onShow(); }
  hide(): void { if (!this._visible) return; this._visible = false; this.el.classList.remove('visible'); this.el.setAttribute('aria-hidden', 'true'); this.onHide(); }
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

export function screenHeader(ctx: ScreenContext, title: string, subtitle?: string, ...extra: HTMLElement[]): HTMLElement {
  return h('header', { class: 'screen-header' },
    button('', () => ctx.back(), { icon: 'back', cls: 'btn-ghost btn-icon', title: 'Back (Esc)', aria: { label: 'Back' } }),
    h('h1', { class: 'screen-title', text: title }),
    subtitle ? h('span', { class: 'screen-subtitle', text: subtitle }) : null,
    h('span', { class: 'spacer' }),
    ...extra);
}
