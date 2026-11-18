/** Pilot logbook (host.logbook()): totals and one row per flight, newest first. */
import { Screen, screenHeader, type ScreenContext } from './Screen';
import { button, clear, h } from '../dom';
import type { LogbookView } from '../UiHost';

/** 1:05 (hours:minutes) */
export function formatLogTime(s: number): string {
  const m = Math.round(Math.max(0, s) / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

export class LogbookScreen extends Screen {
  private body: HTMLElement;
  private clearBtn: HTMLButtonElement;
  constructor(private readonly ctx: ScreenContext) {
    super('logbook');
    this.body = h('div', { class: 'logbook-body' });
    this.clearBtn = button('Clear logbook', () => {
      if (!confirm('Delete every logbook entry?')) return;
      this.ctx.host.clearLogbook?.();
      this.render();
    }, { cls: 'btn-ghost btn-sm' });
    this.el.append(screenHeader(ctx, 'Logbook', 'Every flight over 30 seconds in the air', this.clearBtn),
      h('div', { class: 'screen-body' }, h('div', { class: 'panel credits-card logbook-card scroll' }, this.body)));
  }

  protected override onShow(): void { this.render(); }

  private render(): void {
    clear(this.body);
    const view: LogbookView = this.ctx.host.logbook?.() ?? { entries: [], totals: { flights: 0, airTimeS: 0, nightS: 0, landings: 0, distanceNm: 0 } };
    const t = view.totals;
    this.clearBtn.style.display = view.entries.length ? '' : 'none';
    const stat = (k: string, v: string) => h('div', { class: 'logbook-stat' }, h('div', { class: 'summary-k', text: k }), h('div', { class: 'logbook-stat-v', text: v }));
    this.body.append(h('div', { class: 'logbook-totals' },
      stat('Flights', String(t.flights)), stat('Flight time', formatLogTime(t.airTimeS)), stat('Night', formatLogTime(t.nightS)),
      stat('Landings', String(t.landings)), stat('Distance', `${Math.round(t.distanceNm)} nm`)));
    if (!view.entries.length) {
      this.body.append(h('p', { class: 'muted', style: 'margin-top:16px', text: 'No flights yet. Flights are logged when they end (a new flight, or closing the page).' }));
      return;
    }
    const head = h('tr', null, ...['Date', 'Aircraft', 'From', 'To', 'Time', 'Night', 'Ldg', 'Dist', 'Max alt'].map((c) => h('th', { text: c })));
    const rows = view.entries.map((e) => h('tr', { class: e.crashed ? 'logbook-crash' : '' },
      h('td', { text: new Date(e.startUtcMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }),
      h('td', { text: e.aircraftName }),
      h('td', { class: 'mono', text: e.from ?? '—' }),
      h('td', { class: 'mono', text: e.crashed ? 'crashed' : (e.to ?? '—') }),
      h('td', { class: 'mono', text: formatLogTime(e.airTimeS) }),
      h('td', { class: 'mono', text: e.nightS > 0 ? formatLogTime(e.nightS) : '' }),
      h('td', { class: 'mono', text: String(e.landings) }),
      h('td', { class: 'mono', text: `${e.distanceNm.toFixed(1)} nm` }),
      h('td', { class: 'mono', text: `${e.maxAltFt.toLocaleString()} ft` })));
    this.body.append(h('table', { class: 'logbook-table' }, h('thead', null, head), h('tbody', null, ...rows)));
  }
}
