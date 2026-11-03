/** ATC panel: numbered options from 'atc:options' (1–9, 0), transcript of 'atc:message', frequency header. */
import type { SimAction, SimEvents, SimSnapshot } from '../../core/types';
import type { UiHost } from '../UiHost';
import { Txt, button, clear, h, icon } from '../dom';
import { formatFrequencyMHz, formatTimeUtc } from '../format';

const OPTION_ACTIONS: SimAction[] = ['atcOption1', 'atcOption2', 'atcOption3', 'atcOption4', 'atcOption5', 'atcOption6', 'atcOption7', 'atcOption8', 'atcOption9', 'atcOption0'];
const EMPTY_LOG = 'No transmissions yet. Tune a frequency and pick an option below.';

export class AtcWindow {
  readonly el: HTMLElement;
  private log: HTMLElement;
  private options: HTMLElement;
  private freq: Txt;
  private station: Txt;
  private lastFreqMHz: number | null = null;
  private count = 0;
  private readonly maxMessages = 80;

  constructor(container: HTMLElement, private readonly host: UiHost) {
    this.freq = new Txt(h('span', { text: '---.---' }));
    this.station = new Txt(h('span', { class: 'muted', style: 'font-family:var(--font);font-size:.8em' }), '');
    this.log = h('div', { class: 'atc-log scroll' }, h('div', { class: 'empty', text: EMPTY_LOG }));
    this.options = h('div', { class: 'atc-options' }, h('div', { class: 'empty', text: 'No options available' }));
    this.el = h('div', { class: 'atc' },
      h('div', { class: 'atc-freq' }, icon('headset'), this.freq.el, this.station.el, h('span', { class: 'spacer' }),
        // a text button: a second "×" right under the panel's close button read as "close"
        button('Clear', () => this.clearLog(), { cls: 'btn-ghost btn-sm', title: 'Clear transcript' })),
      this.log,
      h('div', { class: 'section-label', text: 'Options (keys 1–9, 0)' }),
      this.options);
    container.appendChild(this.el);
  }

  setOptions(p: SimEvents['atc:options']): void {
    clear(this.options);
    if (!p.options.length) { this.options.appendChild(h('div', { class: 'empty', text: 'No options available' })); return; }
    p.options.slice(0, 10).forEach((text, i) => {
      const key = i === 9 ? '0' : String(i + 1);
      this.options.appendChild(h('button', { class: 'btn atc-opt', type: 'button', onClick: () => this.host.dispatch(OPTION_ACTIONS[i]) },
        h('span', { class: 'key', text: key }), h('span', { text })));
    });
  }

  addMessage(m: SimEvents['atc:message'], utcMs: number): void {
    if (this.count === 0) clear(this.log);
    if (m.frequencyMHz !== undefined) { this.lastFreqMHz = m.frequencyMHz; this.freq.set(formatFrequencyMHz(m.frequencyMHz)); }
    this.log.appendChild(h('div', { class: `atc-msg from-${m.from}` },
      h('span', { class: 'ts', text: formatTimeUtc(utcMs) }), h('span', { class: 'from', text: m.from === 'atc' ? 'ATC' : 'You' }), h('span', { text: m.text })));
    this.count++;
    while (this.count > this.maxMessages && this.log.firstChild) { this.log.removeChild(this.log.firstChild); this.count--; }
    this.log.scrollTop = this.log.scrollHeight;
  }

  clearLog(placeholder = 'Transcript cleared'): void { clear(this.log); this.count = 0; this.log.appendChild(h('div', { class: 'empty', text: placeholder })); }

  /** A new flight: empty transcript, no stale frequency or station. */
  reset(): void {
    this.clearLog(EMPTY_LOG);
    this.lastFreqMHz = null;
    this.freq.set('---.---');
    this.station.set('');
  }

  /**
   * 1 Hz while visible: the tuned COM1 frequency (host.comRadio when the host reports it, else the
   * last transmission's) and the nearest airport station using it.
   */
  update(s: SimSnapshot): void {
    let com: number | null = null;
    try { com = this.host.comRadio?.()?.activeMHz ?? null; } catch { com = null; }
    if (com !== null && Number.isFinite(com) && com !== this.lastFreqMHz) { this.lastFreqMHz = com; this.freq.set(formatFrequencyMHz(com)); }
    if (this.lastFreqMHz === null) return;
    const aps = this.host.nav.nearestAirports(s.aircraft.geo, 3, 30);
    for (const ap of aps) {
      const f = ap.frequencies?.find((x) => Math.abs(x.mhz - this.lastFreqMHz!) < 0.006);
      if (f) { this.station.set(`${ap.icao} ${f.type}`); return; }
    }
    this.station.set('');
  }
}
