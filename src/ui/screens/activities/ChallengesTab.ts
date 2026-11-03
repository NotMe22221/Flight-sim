/**
 * Activities › Landing challenges (doc 01 §10.1): Famous / Epic / Strong Wind filters, a list with
 * best scores (localStorage), a briefing card, and Start → host.startChallenge(id).
 */
import type { ScreenContext } from '../Screen';
import { Txt, button, clear, h, icon, isNarrowScreen } from '../../dom';
import {
  CHALLENGE_FILTERS, categoryCounts, challengeConditions, challengesIn, landingChallenges, loadBestScores,
  type BestScores, type CategoryFilter, type LandingChallenge,
} from '../../activities';
import { scoreBand } from '../../landingReportModel';
import { formatDateUtc } from '../../format';
import { StartGate, type ActivityTabView } from './types';

export class ChallengesTab implements ActivityTabView {
  readonly el: HTMLElement;
  private filter: CategoryFilter = 'All';
  private selectedId: string | null = null;
  private best: BestScores = {};
  private tabs = new Map<CategoryFilter, HTMLButtonElement>();
  private list: HTMLElement;
  private detail: HTMLElement;
  private cards = new Map<string, HTMLElement>();
  private startBtn: HTMLButtonElement | null = null;
  private status: Txt;
  /** Start is disabled while a lesson / bush leg is still being set up (spawns are serialised) */
  private gate: StartGate;

  constructor(private readonly ctx: ScreenContext) {
    this.gate = new StartGate(ctx);
    const bar = h('div', { class: 'tabs act-filters', role: 'tablist', aria: { label: 'Challenge categories' } });
    for (const f of CHALLENGE_FILTERS) {
      const b = h('button', { class: 'tab', type: 'button', role: 'tab', onClick: () => this.setFilter(f) });
      this.tabs.set(f, b);
      bar.appendChild(b);
    }
    this.list = h('div', { class: 'act-list scroll', role: 'listbox', aria: { label: 'Landing challenges' } });
    this.detail = h('aside', { class: 'panel act-detail' });
    this.status = new Txt(h('div', { class: 'muted', style: 'font-size:.85em' }), '');
    this.el = h('div', { class: 'screen-body act-body' },
      h('div', { class: 'act-left' }, bar, this.list),
      this.detail);
  }

  onShow(): void {
    this.best = loadBestScores();
    const list = landingChallenges();
    if (!this.selectedId || !list.some((c) => c.id === this.selectedId)) this.selectedId = list[0]?.id ?? null;
    this.renderTabs();
    this.renderList();
    this.renderDetail();
  }

  update(): void { this.gate.update(); }

  // no scroll: on a phone the briefing (and its Start button) sits below the list
  focus(): void { (this.startBtn ?? this.tabs.get(this.filter))?.focus({ preventScroll: true }); }

  private setFilter(f: CategoryFilter): void {
    this.filter = f;
    const visible = challengesIn(landingChallenges(), f);
    if (!visible.some((c) => c.id === this.selectedId)) this.selectedId = visible[0]?.id ?? null;
    this.renderTabs();
    this.renderList();
    this.renderDetail();
  }

  private renderTabs(): void {
    const counts = categoryCounts(landingChallenges());
    for (const [f, b] of this.tabs) {
      b.textContent = `${f} (${counts[f]})`;
      b.classList.toggle('active', f === this.filter);
      b.setAttribute('aria-selected', String(f === this.filter));
    }
  }

  private renderList(): void {
    clear(this.list);
    this.cards.clear();
    const items = challengesIn(landingChallenges(), this.filter);
    if (!items.length) { this.list.appendChild(h('div', { class: 'empty', text: 'No challenges in this category' })); return; }
    for (const c of items) {
      const best = this.best[c.id];
      const card = h('div', {
        class: 'panel act-card', role: 'option', tabIndex: 0, aria: { selected: c.id === this.selectedId },
        onClick: () => this.select(c.id),
        onKeyDown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (this.selectedId === c.id) this.start(c); else this.select(c.id); }
          else if (e.key === ' ') { e.preventDefault(); this.select(c.id); }
        },
      },
      h('div', { class: 'row' }, h('span', { class: 'act-title', text: c.title }), h('span', { class: 'spacer' }), h('span', { class: `badge${c.category === 'Epic' ? ' badge-accent' : c.category === 'Strong Wind' ? ' badge-warn' : ''}`, text: c.category })),
      h('div', { class: 'act-meta' }, h('span', { class: 'airport-icao', text: c.icao }), ` · runway ${c.runway} · ${c.description}`),
      h('div', { class: 'act-best' }, icon('trophy'), best ? `${best.score.toLocaleString('en-US')} · ${scoreBand(best.score)}` : 'Not flown yet'));
      card.classList.toggle('selected', c.id === this.selectedId);
      this.cards.set(c.id, card);
      this.list.appendChild(card);
    }
  }

  private select(id: string): void {
    this.selectedId = id;
    for (const [k, el] of this.cards) { el.classList.toggle('selected', k === id); el.setAttribute('aria-selected', String(k === id)); }
    this.renderDetail();
    // single-column phone layout: the briefing is below the list, bring it (and Start) into view
    if (isNarrowScreen()) this.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private renderDetail(): void {
    clear(this.detail);
    this.startBtn = null;
    const c = landingChallenges().find((x) => x.id === this.selectedId);
    if (!c) { this.detail.appendChild(h('div', { class: 'empty', text: 'Select a challenge' })); return; }
    const b = challengeConditions(c);
    const best = this.best[c.id];
    const canStart = typeof this.ctx.host.startChallenge === 'function';
    this.gate.reset();
    this.startBtn = this.gate.add(button('Start', () => this.start(c), { primary: true, big: true, icon: 'play', title: canStart ? `Fly ${c.title}` : 'Not available in this build' }), canStart);
    this.status.set(canStart ? 'You start trimmed on final with approach flaps. Land on the centreline, gently, near the aiming point, and stop.' : 'Landing challenges are not available in this build.');
    this.detail.append(
      h('div', { class: 'row' }, h('span', { class: 'badge', text: c.category }), h('span', { class: 'spacer' }), h('span', { class: 'airport-icao', text: c.icao })),
      h('h2', { class: 'act-detail-title', text: c.title }),
      h('p', { class: 'muted', style: 'margin:0', text: c.description }),
      h('div', { class: 'section-label', text: 'Briefing' }),
      h('div', { class: 'kv' },
        h('span', { class: 'kv-k', text: 'Airport' }), h('span', { class: 'kv-v', text: b.airport }),
        h('span', { class: 'kv-k', text: 'Approach' }), h('span', { class: 'kv-v', text: b.approach }),
        h('span', { class: 'kv-k', text: 'Weather' }), h('span', { class: 'kv-v', text: b.weather }),
        h('span', { class: 'kv-k', text: 'Wind' }), h('span', { class: 'kv-v mono', text: b.wind }),
        h('span', { class: 'kv-k', text: 'Time' }), h('span', { class: 'kv-v', text: b.time })),
      h('div', { class: 'section-label', text: 'Scoring' }),
      h('div', { class: 'muted', style: 'font-size:.85em', text: 'Touchdown rate 35 % · centreline 30 % · stopping distance 20 % · aim point 15 %.' }),
      h('div', { class: 'act-best big' }, icon('trophy'),
        best ? `Best ${best.score.toLocaleString('en-US')} · ${scoreBand(best.score)}${best.atMs ? ` · ${formatDateUtc(best.atMs)}` : ''}` : 'No score yet'),
      h('span', { class: 'spacer' }),
      this.status.el,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, this.startBtn));
  }

  private start(c: LandingChallenge): void {
    if (typeof this.ctx.host.startChallenge !== 'function' || this.gate.starting) return;
    if (this.ctx.startChallenge) this.ctx.startChallenge(c.id);
    else void this.ctx.host.startChallenge(c.id).catch((e: unknown) => this.ctx.toast(`Could not start ${c.title}: ${e instanceof Error ? e.message : String(e)}`, 'error'));
  }
}
