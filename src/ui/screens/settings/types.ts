/** Contract between the Settings screen and its tabs. */
import type { ScreenContext } from '../Screen';
import type { SettingsAction } from '../../settingsModel';
import { h } from '../../dom';

export interface TabDeps {
  ctx: ScreenContext;
  /** Runs the settings reducer, persists and pushes the changed groups, then re-syncs every tab. */
  dispatch(a: SettingsAction): void;
}

export interface SettingsTabView {
  readonly el: HTMLElement;
  /** Update every control from ctx.settings() without rebuilding (keeps focus and drags). */
  sync(): void;
  /** Tab became visible. */
  onShow?(): void;
  /** Return true when the key was consumed (e.g. Esc while waiting for a rebind). */
  onKey?(e: KeyboardEvent): boolean;
  dispose?(): void;
}

/** A label + control row laid out like the slider rows. */
export function fieldRow(label: string, control: HTMLElement, trailing?: HTMLElement): HTMLElement {
  return h('div', { class: 'slider-row' }, h('span', { class: 'slider-label', text: label }), control, trailing ?? h('span'));
}

/** Titled settings card. */
export function group(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  return h('section', { class: 'panel settings-group' }, h('div', { class: 'section-label', text: title }), ...children);
}
