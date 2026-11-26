/**
 * EFB › Weight & fuel: a slider per seat and baggage station and one for fuel, the take-off weight
 * against MTOW and the centre of gravity on its envelope bar, updated live as the sliders move
 * (host.previewMass). "Load aircraft" applies it, on the ground and stopped only (host.setLoad).
 */
import type { MassState, UiHost } from '../UiHost';
import { Txt, button, clear, h, slider, type SliderHandle } from '../dom';

const LB = 0.45359237;

/** Where the CG sits on the envelope bar, 0 (forward limit) … 1 (aft limit); outside when < 0 or > 1. */
export function cgFraction(cgM: number, limits: [number, number]): number {
  const [fwd, aft] = limits;
  return fwd === aft ? 0.5 : (fwd - cgM) / (fwd - aft);
}

export class TabletWeightFuel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private sliders: SliderHandle[] = [];
  private fuel: SliderHandle | null = null;
  private weight = new Txt(h('div', { class: 'tablet-weight' }), '');
  private cgText = new Txt(h('div', { class: 'muted' }), '');
  private cgMarker = h('div', { class: 'tablet-cg-marker' });
  private note = new Txt(h('div', { class: 'muted tablet-note' }), '');
  private loadBtn: HTMLButtonElement;
  private state: MassState | null = null;
  private stationKey = '';

  constructor(private readonly host: UiHost) {
    this.body = h('div', { class: 'tablet-stations' });
    this.loadBtn = button('Load aircraft', () => this.apply(), { primary: true, icon: 'check', title: 'Load this payload and fuel (on the ground, stopped)' });
    this.el = h('div', { class: 'tablet-page tablet-wb' },
      h('h3', { class: 'tablet-h', text: 'Weight & fuel' }),
      this.body,
      this.weight.el,
      h('div', { class: 'tablet-cg' }, h('div', { class: 'tablet-cg-bar' }, h('span', { text: 'FWD' }), this.cgMarker, h('span', { text: 'AFT' }))),
      this.cgText.el,
      h('div', { class: 'row', style: 'gap:8px' }, this.loadBtn),
      this.note.el);
  }

  /** Read the aircraft's current load into the sliders (on show, and after a new flight or aircraft). */
  onShow(): void {
    let st: MassState | null = null;
    try { st = this.host.massState?.() ?? null; } catch { st = null; }
    this.state = st;
    if (!st) { clear(this.body); this.note.set('Weight & balance is not available.'); return; }
    const key = st.stations.map((s) => `${s.name}:${s.maxKg}`).join('|');
    if (key !== this.stationKey) this.build(st, key);
    st.stations.forEach((s, i) => this.sliders[i]?.set(Math.round(s.kg / LB)));
    this.fuel?.set(Math.round((st.fuelKg / Math.max(st.fuelCapKg, 1e-6)) * 100));
    this.recompute();
  }

  private build(st: MassState, key: string): void {
    clear(this.body);
    this.stationKey = key;
    this.sliders = st.stations.map((s) => slider({
      min: 0, max: Math.round(s.maxKg / LB), step: 5, value: Math.round(s.kg / LB), label: s.name, format: (v) => `${v} lb`,
      onInput: () => this.recompute(),
    }));
    this.fuel = slider({
      min: 0, max: 100, step: 5, value: 100, label: 'Fuel',
      format: (v) => `${v} % · ${Math.round((st.fuelCapKg * v) / 100 / st.fuelKgPerGal)} gal`,
      onInput: () => this.recompute(),
    });
    for (const s of this.sliders) this.body.appendChild(s.el);
    this.body.appendChild(this.fuel.el);
  }

  private proposal(): { stationKg: number[]; fuel: number } {
    return { stationKg: this.sliders.map((s) => Number(s.input.value) * LB), fuel: Number(this.fuel?.input.value ?? 100) / 100 };
  }

  private recompute(): void {
    const st = this.state;
    if (!st) return;
    const p = this.proposal();
    let m: { totalKg: number; cgM: number } | null = null;
    try { m = this.host.previewMass?.(p.stationKg, p.fuel) ?? null; } catch { m = null; }
    if (!m) return;
    const over = m.totalKg > st.mtowKg + 0.5;
    this.weight.set(`Weight ${Math.round(m.totalKg / LB).toLocaleString('en-US')} lb of ${Math.round(st.mtowKg / LB).toLocaleString('en-US')} lb max${over ? ' · OVER MAX TAKE-OFF WEIGHT' : ''}`);
    this.weight.el.classList.toggle('over', over);
    if (st.cgLimitsM) {
      const f = cgFraction(m.cgM, st.cgLimitsM);
      const out = f < -0.001 || f > 1.001;
      this.cgMarker.style.left = `${Math.min(Math.max(f, 0), 1) * 100}%`;
      this.cgMarker.classList.toggle('over', out);
      this.cgText.set(out ? 'Centre of gravity OUT OF LIMITS: move load forward or aft' : 'Centre of gravity within limits');
    } else this.cgText.set('');
    this.loadBtn.disabled = !st.canLoad;
    this.note.set(st.canLoad ? '' : 'Payload and fuel can be changed on the ground with the aircraft stopped.');
  }

  private apply(): void {
    const p = this.proposal();
    let ok = false;
    try { ok = this.host.setLoad?.(p.stationKg, p.fuel) ?? false; } catch { ok = false; }
    if (ok) this.onShow();
    this.note.set(ok ? 'Loaded: payload and fuel are on board.' : 'Stop on the ground to change the load.');
  }

  /** Throttled refresh while visible: follows the aircraft stopping or rolling, and fuel burn. */
  update(): void {
    let st: MassState | null = null;
    try { st = this.host.massState?.() ?? null; } catch { st = null; }
    if (!st || !this.state) return;
    if (st.canLoad !== this.state.canLoad) { this.state = st; this.recompute(); }
  }
}
