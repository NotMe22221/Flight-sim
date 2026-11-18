/**
 * Activities › Discovery flights: scenic air starts at famous landscapes (DISCOVERY_FLIGHTS): a list
 * and a briefing card, Start → host.startDiscovery(id).
 */
import type { ScreenContext } from '../Screen';
import { Txt, button, clear, h, icon, isNarrowScreen } from '../../dom';
import { DISCOVERY_FLIGHTS, type DiscoveryFlight } from '../../../activities/discovery';
import { aircraftName } from './TrainingTab';
import { StartGate, type ActivityTabView } from './types';

const TIME_TEXT: Record<DiscoveryFlight['time'], string> = { morning: 'Morning', noon: 'Midday', afternoon: 'Afternoon', dusk: 'Sunset' };
const WEATHER_TEXT: Record<string, string> = { clear: 'Clear skies', few: 'Few clouds', scattered: 'Scattered clouds' };

export class DiscoveryTab implements ActivityTabView {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private detail: HTMLElement;
  private selectedId: string = DISCOVERY_FLIGHTS[0].id;
  private cards = new Map<string, HTMLElement>();
  private startBtn: HTMLButtonElement | null = null;
  private status = new Txt(h('div', { class: 'muted', style: 'font-size:.85em' }), '');
  private gate: StartGate;

  constructor(private readonly ctx: ScreenContext) {
    this.gate = new StartGate(ctx);
    this.list = h('div', { class: 'act-list scroll', role: 'listbox', aria: { label: 'Discovery flights' } });
    this.detail = h('aside', { class: 'panel act-detail' });
    this.el = h('div', { class: 'screen-body act-body' }, h('div', { class: 'act-left' }, this.list), this.detail);
  }

  onShow(): void { this.renderList(); this.renderDetail(); }
  update(): void { this.gate.update(); }
  focus(): void { (this.startBtn ?? this.cards.get(this.selectedId))?.focus({ preventScroll: true }); }

  private renderList(): void {
    clear(this.list);
    this.cards.clear();
    for (const d of DISCOVERY_FLIGHTS) {
      const card = h('div', {
        class: 'panel act-card', role: 'option', tabIndex: 0, aria: { selected: d.id === this.selectedId },
        onClick: () => this.select(d.id),
        onKeyDown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (this.selectedId === d.id) this.start(d); else this.select(d.id); }
          else if (e.key === ' ') { e.preventDefault(); this.select(d.id); }
        },
      },
      h('div', { class: 'row' }, h('span', { class: 'act-title', text: d.title }), h('span', { class: 'spacer' }), h('span', { class: 'badge', text: TIME_TEXT[d.time] })),
      h('div', { class: 'act-meta', text: d.region }));
      card.classList.toggle('selected', d.id === this.selectedId);
      this.cards.set(d.id, card);
      this.list.appendChild(card);
    }
  }

  private select(id: string): void {
    this.selectedId = id;
    for (const [k, el] of this.cards) { el.classList.toggle('selected', k === id); el.setAttribute('aria-selected', String(k === id)); }
    this.renderDetail();
    if (isNarrowScreen()) this.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private renderDetail(): void {
    clear(this.detail);
    const d = DISCOVERY_FLIGHTS.find((x) => x.id === this.selectedId);
    if (!d) return;
    const canStart = typeof this.ctx.host.startDiscovery === 'function';
    this.gate.reset();
    this.startBtn = this.gate.add(button('Start', () => this.start(d), { primary: true, big: true, icon: 'play', title: canStart ? `Fly ${d.title}` : 'Not available in this build' }), canStart);
    this.status.set(canStart ? 'You start in the air, trimmed and on course. No objectives: just fly.' : 'Discovery flights are not available in this build.');
    const plane = aircraftName(this.ctx, d.aircraft);
    this.detail.append(
      h('div', { class: 'row' }, h('span', { class: 'badge', text: 'Discovery' }), h('span', { class: 'spacer' }), h('span', { class: 'muted', text: d.region })),
      h('h2', { class: 'act-detail-title', text: d.title }),
      h('p', { class: 'muted', style: 'margin:0', text: d.blurb }),
      h('div', { class: 'section-label', text: 'Briefing' }),
      h('div', { class: 'kv' },
        h('span', { class: 'kv-k', text: 'Start' }), h('span', { class: 'kv-v', text: `${d.altFt.toLocaleString('en-US')} ft, heading ${String(d.headingDeg).padStart(3, '0')}°, ${d.iasKt} kt` }),
        h('span', { class: 'kv-k', text: 'Time' }), h('span', { class: 'kv-v', text: TIME_TEXT[d.time] }),
        h('span', { class: 'kv-k', text: 'Weather' }), h('span', { class: 'kv-v', text: WEATHER_TEXT[d.weather] ?? d.weather }),
        ...(plane ? [h('span', { class: 'kv-k', text: 'Aircraft' }), h('span', { class: 'kv-v', text: plane })] : [])),
      ...(d.towers ? [h('div', { class: 'act-best' }, icon('warning'), 'The landmark rises above your altitude: fly beside it.')] : []),
      h('span', { class: 'spacer' }),
      this.status.el,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, this.startBtn));
  }

  private start(d: DiscoveryFlight): void {
    const host = this.ctx.host;
    if (typeof host.startDiscovery !== 'function' || this.gate.starting) return;
    if (this.ctx.startDiscovery) this.ctx.startDiscovery(d.id);
    else void host.startDiscovery(d.id).catch((e: unknown) => this.ctx.toast(`Could not start ${d.title}: ${e instanceof Error ? e.message : String(e)}`, 'error'));
  }
}
