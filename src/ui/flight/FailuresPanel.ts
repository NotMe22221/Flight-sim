/**
 * In-flight failures panel (MSFS "Failures"): a switch per system, random failures, repair all.
 * Feature-detected against the host: without `setFailure` it explains that failures are unavailable.
 */
import { FAILURE_IDS, type FailureId, type SimSnapshot } from '../../core/types';
import type { UiHost } from '../UiHost';
import { button, h, toggle, type ToggleHandle } from '../dom';

export const FAILURE_TEXT: Readonly<Record<FailureId, { label: string; help: string }>> = {
  engine: { label: 'Engine', help: 'Fuel starvation: the engine stops and will not restart. Glide to a field.' },
  vacuum: { label: 'Vacuum pump', help: 'Attitude and heading indicators spin down and drift. Fly partial panel.' },
  pitot: { label: 'Pitot tube blocked', help: 'Airspeed indicator acts as an altimeter: reads high climbing, low descending.' },
  static: { label: 'Static port blocked', help: 'Altimeter and VSI freeze; airspeed reads low climbing.' },
  alternator: { label: 'Alternator', help: 'The battery carries the bus until it runs flat: LOW VOLTS, shed loads.' },
  electrical: { label: 'Electrical system', help: 'Total electrical failure: radios, lights and the G1000 go dark.' },
  avionics: { label: 'Avionics bus', help: 'Radios and the G1000 displays go dark; the engine instruments stay.' },
  carbIce: { label: 'Carburettor ice', help: 'Icing conditions in the carburettor: rpm creeps down, then the engine runs rough. Carb heat clears it. Carburetted engines only (Super Cub).' },
};

export class FailuresPanel {
  readonly el: HTMLElement;
  private readonly toggles = new Map<FailureId, ToggleHandle>();
  private random: ToggleHandle | null = null;
  private lastKey = '';

  constructor(container: HTMLElement, private readonly host: UiHost) {
    this.el = h('div', { class: 'failures-panel' });
    if (!host.setFailure) {
      this.el.appendChild(h('p', { class: 'muted', text: 'Failures are not available in this build.' }));
    } else {
      for (const id of FAILURE_IDS) {
        const t = toggle(FAILURE_TEXT[id].label, false, (on) => host.setFailure!(id, on), FAILURE_TEXT[id].help);
        this.toggles.set(id, t);
        this.el.appendChild(t.el);
      }
      if (host.setRandomFailures) {
        this.random = toggle('Random failures', host.randomFailures?.() ?? false, (on) => host.setRandomFailures!(on), 'About one failure per 45 minutes in the air, without warning.');
        this.el.appendChild(h('div', { class: 'failures-random' }, this.random.el));
      }
      this.el.appendChild(h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:8px' }, button('Repair all', () => { for (const id of FAILURE_IDS) host.setFailure!(id, false); })));
    }
    container.appendChild(this.el);
  }

  /** Reflect the failures in effect (random ones appear here too); DOM writes only on change. */
  update(s: SimSnapshot): void {
    const f = s.failures ?? {};
    const key = FAILURE_IDS.map((id) => (f[id] ? '1' : '0')).join('') + (this.host.randomFailures?.() ? 'r' : '');
    if (key === this.lastKey) return;
    this.lastKey = key;
    for (const [id, t] of this.toggles) if (t.get() !== !!f[id]) t.set(!!f[id]);
    if (this.random) { const r = this.host.randomFailures?.() ?? false; if (this.random.get() !== r) this.random.set(r); }
  }
}
