/**
 * Settings: General (units, assistance, interface) · Graphics · Controls · Audio · Data & credits.
 * Every change goes through the pure settingsReducer; only changed groups are persisted and
 * pushed to the host (UiManager.applySettings).
 */
import { Screen, screenHeader, type ScreenContext } from './Screen';
import { h } from '../dom';
import { SETTINGS_TABS, cycleTab, parseTab, settingsReducer, type SettingsAction, type SettingsTab } from '../settingsModel';
import type { PersistedSettings } from '../settingsStore';
import { loadJson, saveJson } from '../settingsStore';
import type { SettingsTabView, TabDeps } from './settings/types';
import { GeneralTab } from './settings/GeneralTab';
import { GraphicsTab } from './settings/GraphicsTab';
import { ControlsTab } from './settings/ControlsTab';
import { AudioTab } from './settings/AudioTab';
import { DataTab } from './settings/DataTab';

const TAB_KEY = 'flightsim.ui.settingsTab.v1';

export class Settings extends Screen {
  private tab: SettingsTab;
  private tabButtons = new Map<SettingsTab, HTMLButtonElement>();
  private views: Partial<Record<SettingsTab, SettingsTabView>> = {};
  private content: HTMLElement;
  private deps: TabDeps;

  constructor(private readonly ctx: ScreenContext) {
    super('settings');
    this.tab = parseTab(loadJson<unknown>(TAB_KEY, 'general'));
    this.deps = { ctx, dispatch: (a) => this.dispatch(a) };
    const bar = h('div', { class: 'tabs', role: 'tablist', aria: { label: 'Settings sections' } });
    for (const t of SETTINGS_TABS) {
      const b = h('button', { class: 'tab', type: 'button', role: 'tab', text: t.label, dataset: { tab: t.id }, onClick: () => this.select(t.id) });
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        this.select(cycleTab(this.tab, e.key === 'ArrowRight' ? 1 : -1));
        this.tabButtons.get(this.tab)?.focus();
      });
      this.tabButtons.set(t.id, b);
      bar.appendChild(b);
    }
    this.content = h('div', { class: 'settings-content scroll', role: 'tabpanel' });
    this.el.append(screenHeader(ctx, 'Settings', 'Changes apply immediately and are saved in this browser'),
      h('div', { class: 'screen-body' }, bar, this.content));
  }

  /** The current settings tab (for tests / the integrator). */
  get currentTab(): SettingsTab { return this.tab; }

  select(tab: SettingsTab): void {
    this.tab = tab;
    saveJson(TAB_KEY, tab);
    for (const [id, b] of this.tabButtons) {
      b.classList.toggle('active', id === tab);
      b.setAttribute('aria-selected', String(id === tab));
      b.tabIndex = id === tab ? 0 : -1;
    }
    const view = this.view(tab);
    this.content.replaceChildren(view.el);
    view.sync();
    view.onShow?.();
    this.content.scrollTop = 0;
  }

  protected override onShow(): void { this.select(this.tab); }

  override onKey(e: KeyboardEvent): boolean { return this.views[this.tab]?.onKey?.(e) ?? false; }

  override focus(): void { this.tabButtons.get(this.tab)?.focus(); }

  override dispose(): void { for (const v of Object.values(this.views)) v?.dispose?.(); }

  private view(tab: SettingsTab): SettingsTabView {
    let v = this.views[tab];
    if (!v) {
      switch (tab) {
        case 'general': v = new GeneralTab(this.deps); break;
        case 'graphics': v = new GraphicsTab(this.deps); break;
        case 'controls': v = new ControlsTab(this.deps); break;
        case 'audio': v = new AudioTab(this.deps); break;
        case 'data': v = new DataTab(this.deps); break;
      }
      this.views[tab] = v;
    }
    return v;
  }

  private dispatch(a: SettingsAction): void {
    const r = settingsReducer(this.ctx.settings(), a);
    if (r.changed.length === 0) return;
    const patch: Partial<Omit<PersistedSettings, 'version'>> = {};
    for (const g of r.changed) (patch as Record<string, unknown>)[g] = r.next[g];
    this.ctx.applySettings(patch);
    for (const v of Object.values(this.views)) v?.sync();
  }
}
