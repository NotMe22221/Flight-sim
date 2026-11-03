/** Bottom-left status: sim rate, paused, slew, fps, data loading, assists. Cheap: change-only writes. */
import type { SimSnapshot } from '../../core/types';
import { Cls, Txt, h, icon } from '../dom';
import { formatTimeScale } from '../format';
import { ASSIST_ITEMS, assistBadges } from '../assistPresets';

export class StatusBar {
  readonly el: HTMLElement;
  private rate: Txt; private rateItem: Cls;
  private paused: Cls; private slew: Cls;
  private fps: Txt;
  private loading: Txt; private loadingItem: Cls;
  private assists: Txt; private assistsItem: Cls;
  private crash: Cls;
  private lastFpsWrite = 0;
  private lastAssistsMask = -1;
  private lastScale = Number.NaN;
  private lastPct = -1;

  constructor(layer: HTMLElement) {
    const rateEl = h('span', { class: 'status-item' }, icon('fast'), h('span'));
    const pausedEl = h('span', { class: 'status-item warn hidden' }, icon('pause'), 'PAUSED');
    const slewEl = h('span', { class: 'status-item warn hidden' }, icon('target'), 'SLEW');
    const crashEl = h('span', { class: 'status-item err hidden' }, icon('warning'), 'CRASHED');
    const fpsEl = h('span', { class: 'status-item' }, h('span'), ' fps');
    const loadingEl = h('span', { class: 'status-item accent hidden' }, icon('layers'), h('span'));
    const assistsEl = h('span', { class: 'status-item hidden', title: 'Active assistance' }, icon('check'), h('span'));
    this.el = h('div', { class: 'panel status-bar', role: 'status' }, rateEl, pausedEl, slewEl, crashEl, fpsEl, loadingEl, assistsEl);
    this.rate = new Txt(rateEl.lastElementChild as HTMLElement); this.rateItem = new Cls(rateEl, 'accent');
    this.paused = new Cls(pausedEl, 'hidden'); this.slew = new Cls(slewEl, 'hidden'); this.crash = new Cls(crashEl, 'hidden');
    this.fps = new Txt(fpsEl.firstElementChild as HTMLElement);
    this.loading = new Txt(loadingEl.lastElementChild as HTMLElement); this.loadingItem = new Cls(loadingEl, 'hidden');
    this.assists = new Txt(assistsEl.lastElementChild as HTMLElement); this.assistsItem = new Cls(assistsEl, 'hidden');
    layer.appendChild(this.el);
  }

  update(s: SimSnapshot, nowMs: number): void {
    const scale = s.paused ? 0 : s.time.timeScale;
    if (scale !== this.lastScale) { this.lastScale = scale; this.rate.set(formatTimeScale(scale)); this.rateItem.set(scale !== 1 && scale !== 0); }
    this.paused.set(!s.paused);
    this.slew.set(!s.slew);
    this.crash.set(!s.aircraft.crashed);
    if (nowMs - this.lastFpsWrite > 500) { this.lastFpsWrite = nowMs; this.fps.set(Math.round(s.fps).toString()); }
    const loading = s.terrainReady < 0.999;
    this.loadingItem.set(!loading);
    const pct = Math.round(s.terrainReady * 100);
    if (loading && pct !== this.lastPct) { this.lastPct = pct; this.loading.set(`Loading terrain ${pct}%`); }
    // bitmask of the assist flags: badges (an array) are only rebuilt when something changed
    const a = s.assists;
    let mask = 0;
    for (let i = 0; i < ASSIST_ITEMS.length; i++) if (a[ASSIST_ITEMS[i].key]) mask |= 1 << i;
    if (mask !== this.lastAssistsMask) {
      this.lastAssistsMask = mask;
      const badges = assistBadges(a);
      this.assistsItem.set(badges.length === 0);
      this.assists.set(badges.length <= 2 ? badges.join(' · ') : `${badges.length} ASSISTS`);
      this.el.lastElementChild!.setAttribute('title', badges.length ? `Active assistance: ${badges.join(', ')}` : '');
    }
  }
}
