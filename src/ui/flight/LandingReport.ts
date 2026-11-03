/** Landing score card from 'landing:scored'. The pure payload adapter lives in ../landingReportModel. */
import type { SimEvents } from '../../core/types';
import type { UnitsSettings } from '../UiHost';
import { button, clear, h, icon, trapFocus } from '../dom';
import { landingBand, landingComponents, landingExtras, landingRunway } from '../landingReportModel';

export { landingComponents, scoreBand } from '../landingReportModel';

type Payload = SimEvents['landing:scored'];

export class LandingReport {
  readonly el: HTMLElement;
  private card: HTMLElement;
  private onClose?: () => void;

  constructor(layer: HTMLElement) {
    this.card = h('div', { class: 'panel landing-report', role: 'dialog', aria: { label: 'Landing report' } });
    trapFocus(this.card);
    this.el = h('div', { class: 'modal-backdrop', onClick: (e) => { if (e.target === this.el) this.hide(); } }, this.card);
    layer.appendChild(this.el);
  }

  get visible(): boolean { return this.el.classList.contains('visible'); }

  show(p: Payload, units: UnitsSettings, onClose?: () => void): void {
    this.onClose = onClose;
    clear(this.card);
    const comps = landingComponents(p.details, units, p.score);
    const runway = landingRunway(p.details);
    this.card.append(
      h('div', { class: 'row' }, icon('trophy'), h('span', { class: 'section-label', style: 'margin:0;border:0;flex:1', text: `Landing report${runway ? ' · ' + runway : ''}` })),
      h('div', { class: 'lr-score', text: Math.round(p.score).toLocaleString('en-US') }),
      h('div', { class: 'lr-band', text: landingBand(p.details, p.score) }),
      h('hr'),
      ...comps.map((c) => h('div', { class: 'lr-row' },
        h('span', { text: c.label }),
        h('div', { class: 'lr-bar' }, h('span', { style: `width:${c.frac === null ? 0 : Math.round(c.frac * 100)}%` })),
        h('span', { class: 'lr-raw', text: c.frac === null ? '--' : `${Math.round(c.frac * 100)}%` + (c.raw ? ` · ${c.raw}` : '') }),
        h('span', { class: 'lr-weight', text: `${Math.round(c.weight * 100)}%` }),
      )),
      ...landingExtras(p.details).map((x) => h('div', { class: 'row', style: 'justify-content:space-between;font-size:.85em' },
        h('span', { class: 'muted', text: x.label }), h('span', { class: 'tnum', text: x.value }))),
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:8px' }, button('Continue', () => this.hide(), { primary: true })),
    );
    this.el.classList.add('visible');
    (this.card.querySelector('button.btn-primary') as HTMLButtonElement | null)?.focus();
  }

  hide(): void {
    if (!this.visible) return;
    this.el.classList.remove('visible');
    const cb = this.onClose; this.onClose = undefined; cb?.();
  }
}
