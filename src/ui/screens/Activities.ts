/**
 * Activities (doc 01 §10): three tabs, as in MSFS — Landing challenges (Famous / Epic / Strong Wind,
 * best scores), Flight training (lessons with an instructor) and Bush trips (multi-leg VFR journeys).
 * Starting any of them shows the flight loading screen and then the flight view.
 */
import { Screen, screenHeader, type ScreenContext } from './Screen';
import { Txt, h, icon } from '../dom';
import { loadJson, saveJson } from '../settingsStore';
import { ChallengesTab } from './activities/ChallengesTab';
import { TrainingTab } from './activities/TrainingTab';
import { BushTripsTab } from './activities/BushTripsTab';
import { ACTIVITY_TABS, parseActivitiesTab, type ActivitiesTab, type ActivityTabView } from './activities/types';

const TAB_KEY = 'flightsim.ui.activitiesTab.v1';

export class Activities extends Screen {
  private tab: ActivitiesTab;
  private readonly views: Record<ActivitiesTab, ActivityTabView>;
  private readonly tabButtons = new Map<ActivitiesTab, HTMLButtonElement>();
  private readonly host: HTMLElement;
  private readonly subtitle: Txt;
  private shown: ActivityTabView | null = null;

  constructor(private readonly ctx: ScreenContext) {
    super('activities');
    this.tab = parseActivitiesTab(loadJson<unknown>(TAB_KEY, 'challenges'));
    this.views = { challenges: new ChallengesTab(ctx), training: new TrainingTab(ctx), bush: new BushTripsTab(ctx) };
    const bar = h('div', { class: 'tabs act-modes', role: 'tablist', aria: { label: 'Activity types' } });
    ACTIVITY_TABS.forEach((t, i) => {
      const b = h('button', { class: 'tab', type: 'button', role: 'tab', dataset: { tab: t.id }, onClick: () => this.select(t.id) }, icon(t.icon), h('span', { text: t.label }));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const n = ACTIVITY_TABS.length;
        const next = ACTIVITY_TABS[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n].id;
        this.select(next);
        this.tabButtons.get(next)?.focus();
      });
      this.tabButtons.set(t.id, b);
      bar.appendChild(b);
    });
    const header = screenHeader(ctx, 'Activities');
    this.subtitle = new Txt(h('span', { class: 'screen-subtitle' }), '');
    header.insertBefore(this.subtitle.el, header.querySelector('.spacer'));
    this.host = h('div', { class: 'act-host', role: 'tabpanel' });
    this.el.append(header, h('div', { class: 'act-modes-wrap' }, bar), this.host);
  }

  /** The visible tab (for tests / the integrator). */
  get currentTab(): ActivitiesTab { return this.tab; }

  select(tab: ActivitiesTab): void {
    if (tab !== this.tab) { this.tab = tab; saveJson(TAB_KEY, tab); }
    this.mount();
  }

  protected override onShow(): void { this.mount(); }

  override focus(): void { this.shown?.focus(); }

  override update(): void { this.shown?.update(); }

  private mount(): void {
    for (const [id, b] of this.tabButtons) {
      const on = id === this.tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    this.subtitle.set(ACTIVITY_TABS.find((t) => t.id === this.tab)?.subtitle ?? '');
    const view = this.views[this.tab];
    if (this.shown !== view) {
      this.shown?.el.remove();
      this.host.appendChild(view.el);
      this.shown = view;
    }
    view.onShow();
  }
}
