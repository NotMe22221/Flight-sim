/**
 * The EFB tablet (MSFS 2024's in-cockpit tablet; Tab or the toolbar's "Tablet"): one window with a tab
 * strip — Map, Flight plan, Nav log, Weather, Checklist, Weight & fuel. It hosts its own instances of the
 * in-flight panel contents (VfrMap, NavLog, WeatherPanel, Checklist), so the toolbar's floating panels
 * keep working beside it. Not modal: the simulation keeps running behind it. Only the open tab updates.
 */
import type { SimSnapshot } from '../../core/types';
import type { UiHost, UnitsSettings } from '../UiHost';
import type { ScreenContext } from '../screens/Screen';
import { WeatherPanel } from '../screens/WeatherPanel';
import { checklistsFor } from '../aircraftInfo';
import { button, h, icon } from '../dom';
import type { IconName } from '../icons';
import { Checklist } from './Checklist';
import { NavLog } from './NavLog';
import { TabletFlightPlan } from './TabletFlightPlan';
import { TabletWeightFuel } from './TabletWeightFuel';
import { VfrMap } from './VfrMap';

export type TabletTab = 'map' | 'plan' | 'navlog' | 'weather' | 'checklist' | 'wb';
export const TABLET_TABS: readonly { id: TabletTab; label: string; icon: IconName }[] = [
  { id: 'map', label: 'Map', icon: 'map' },
  { id: 'plan', label: 'Flight plan', icon: 'route' },
  { id: 'navlog', label: 'Nav log', icon: 'list' },
  { id: 'weather', label: 'Weather', icon: 'cloudSun' },
  { id: 'checklist', label: 'Checklist', icon: 'checklist' },
  { id: 'wb', label: 'Weight & fuel', icon: 'weight' },
];

export interface TabletDeps {
  host: UiHost;
  ctx: ScreenContext;
  layer: HTMLElement;
  units: () => UnitsSettings;
  onVisibility?: (visible: boolean) => void;
}

export class Tablet {
  readonly el: HTMLElement;
  private tab: TabletTab = 'map';
  private pages = new Map<TabletTab, HTMLElement>();
  private tabButtons = new Map<TabletTab, HTMLButtonElement>();
  private map: VfrMap;
  private navlog: NavLog;
  private weather: WeatherPanel;
  private checklist: Checklist;
  readonly plan: TabletFlightPlan;
  readonly wb: TabletWeightFuel;
  private last: SimSnapshot | null = null;
  private lastWb = -Infinity;

  constructor(private readonly d: TabletDeps) {
    const screen = h('div', { class: 'tablet-screen' });
    const page = (id: TabletTab, el: HTMLElement) => { el.classList.add('tablet-pane'); this.pages.set(id, el); screen.appendChild(el); return el; };
    const mapBox = page('map', h('div', { class: 'tablet-map' }));
    this.map = new VfrMap(mapBox, d.host, d.units);
    this.plan = new TabletFlightPlan(d.host);
    page('plan', this.plan.el);
    const nl = page('navlog', h('div', { class: 'tablet-page' }));
    this.navlog = new NavLog(nl, d.host, d.units);
    this.weather = new WeatherPanel(d.ctx, { compact: true });
    page('weather', h('div', { class: 'tablet-page' }, this.weather.el));
    const cl = page('checklist', h('div', { class: 'tablet-page' }));
    this.checklist = new Checklist(cl);
    this.wb = new TabletWeightFuel(d.host);
    page('wb', this.wb.el);

    const strip = h('nav', { class: 'tablet-tabs', role: 'tablist' });
    for (const t of TABLET_TABS) {
      const b = h('button', { class: 'tablet-tab', type: 'button', role: 'tab', title: t.label, onClick: () => this.select(t.id) }, icon(t.icon), h('span', { text: t.label }));
      this.tabButtons.set(t.id, b);
      strip.appendChild(b);
    }
    strip.appendChild(h('div', { style: 'flex:1' }));
    strip.appendChild(button('', () => this.hide(), { icon: 'close', cls: 'btn-ghost btn-icon', title: 'Close the tablet (Tab)' }));
    this.el = h('div', { class: 'tablet', role: 'dialog', aria: { label: 'EFB tablet' } },
      h('div', { class: 'tablet-bezel' }, strip, screen));
    d.layer.appendChild(this.el);
    this.select('map');
  }

  get visible(): boolean { return this.el.classList.contains('visible'); }
  get current(): TabletTab { return this.tab; }

  show(): void {
    if (this.visible) return;
    this.el.classList.add('visible');
    this.onTabShown();
    this.d.onVisibility?.(true);
  }
  hide(): void {
    if (!this.visible) return;
    this.el.classList.remove('visible');
    this.d.onVisibility?.(false);
  }
  toggle(): void { if (this.visible) this.hide(); else this.show(); }

  select(id: TabletTab): void {
    this.tab = id;
    for (const [k, el] of this.pages) el.style.display = k === id ? '' : 'none';
    for (const [k, b] of this.tabButtons) { b.classList.toggle('active', k === id); b.setAttribute('aria-selected', String(k === id)); }
    if (this.visible) this.onTabShown();
  }

  private onTabShown(): void {
    if (this.tab === 'plan') this.plan.onShow(this.last);
    if (this.tab === 'wb') this.wb.onShow();
  }

  /** New flight: the current aircraft's checklist, a fresh flight-plan form and the new load. */
  reset(): void {
    let ac = null;
    try { ac = this.d.host.currentAircraft(); } catch { ac = null; }
    this.checklist.setSections(checklistsFor(ac));
    this.checklist.resetAll();
    this.plan.reset();
    if (this.visible) this.onTabShown();
  }

  /** Per frame in flight; only the open tab works. */
  update(s: SimSnapshot, nowMs: number): void {
    this.last = s;
    if (!this.visible) return;
    switch (this.tab) {
      case 'map': this.map.update(s, nowMs); break;
      case 'navlog': this.navlog.update(s, nowMs); break;
      case 'weather': this.weather.update(s, nowMs); break;
      case 'checklist': this.checklist.update(s, nowMs); break;
      case 'wb': if (nowMs - this.lastWb > 500) { this.lastWb = nowMs; this.wb.update(); } break;
      default: break;
    }
  }

  dispose(): void { this.weather.dispose(); this.el.remove(); }
}
