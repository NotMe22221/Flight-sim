/** Aircraft cards from host.aircraftList() (gear, panel, power, seats, V-speeds) with fuel and payload sliders. */
import type { AircraftConfig } from '../../core/types';
import { Screen, screenHeader, type ScreenContext } from './Screen';
import { button, clear, h, icon, slider, type SliderHandle } from '../dom';
import { formatFuel, formatFuelQuantity, formatMass, formatSpeed, KT_PER_MS } from '../format';
import { aircraftDisplayName } from '../selection';
import { aircraftBlurb, gearKind, hasAutopilot, panelKind, seatCount } from '../aircraftInfo';

const CATEGORY_LABEL: Record<AircraftConfig['category'], string> = { 'ga-piston': 'Propeller', turboprop: 'Turboprop', jet: 'Jet', airliner: 'Airliner' };

/** '150 hp' (piston) or '120 kN' (turbofan). */
const enginePower = (a: AircraftConfig): string => {
  const e = a.propulsion.engine;
  return e.type === 'piston' ? `${Math.round(e.ratedPowerW / 745.7)} hp` : `${Math.round(e.ratedThrustN / 1000)} kN`;
};

export class AircraftSelect extends Screen {
  private grid: HTMLElement;
  private side: HTMLElement;
  private fuel!: SliderHandle;
  private payload!: SliderHandle;
  private fuelInfo: HTMLElement;
  private payloadInfo: HTMLElement;
  private selectedName: HTMLElement;
  private cards = new Map<string, HTMLElement>();

  constructor(private readonly ctx: ScreenContext) {
    super('aircraft');
    this.grid = h('div', { class: 'aircraft-grid', role: 'listbox', aria: { label: 'Aircraft' } });
    this.fuelInfo = h('div', { class: 'muted tnum', style: 'font-size:.85em' });
    this.payloadInfo = h('div', { class: 'muted tnum', style: 'font-size:.85em' });
    this.selectedName = h('div', { class: 'aircraft-name' });
    this.side = h('aside', { class: 'aircraft-side' });
    this.el.append(screenHeader(ctx, 'Aircraft', 'Pick your aircraft, fuel and payload'),
      h('div', { class: 'screen-body' }, this.grid, this.side),
      h('footer', { class: 'screen-footer' }, h('span', { class: 'spacer' }), button('Back', () => ctx.back()), button('Fly', () => ctx.fly(), { primary: true, big: true, icon: 'plane' })));
  }

  private get aircraft(): AircraftConfig | undefined { return this.ctx.host.aircraftList().find((a) => a.id === this.ctx.selection.sel.aircraftId); }

  protected override onShow(): void { this.render(); }

  private render(): void {
    const list = this.ctx.host.aircraftList();
    const u = this.ctx.settings().units;
    clear(this.grid); this.cards.clear();
    if (!list.length) this.grid.appendChild(h('div', { class: 'empty', text: 'No aircraft available' }));
    for (const a of list) {
      const card = h('div', { class: 'panel aircraft-card', role: 'option', tabIndex: 0, aria: { selected: false },
        onClick: () => this.select(a.id), onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(a.id); } } },
        h('div', { class: 'silhouette' }, icon('plane')),
        h('div', { class: 'aircraft-name', text: a.name }),
        h('div', { class: 'aircraft-manu', text: `${a.manufacturer} · ${CATEGORY_LABEL[a.category] ?? a.category} · ${gearKind(a)} · ${panelKind(a)}` }),
        h('div', { class: 'spec-grid' },
          h('span', { class: 'spec-k', text: 'Vne' }), h('span', { text: formatSpeed(a.limits.VneKt / KT_PER_MS, u) }),
          h('span', { class: 'spec-k', text: 'Vs0' }), h('span', { text: formatSpeed(a.limits.VsoKt / KT_PER_MS, u) }),
          h('span', { class: 'spec-k', text: 'Vy' }), h('span', { text: formatSpeed(a.limits.VyKt / KT_PER_MS, u) }),
          h('span', { class: 'spec-k', text: 'MTOW' }), h('span', { text: formatMass(a.mass.maxTakeoffKg, u) }),
          h('span', { class: 'spec-k', text: 'Power' }), h('span', { text: enginePower(a) }),
          h('span', { class: 'spec-k', text: 'Seats' }), h('span', { text: String(seatCount(a)) })));
      this.cards.set(a.id, card);
      this.grid.appendChild(card);
    }
    this.renderSide();
    this.highlight();
  }

  private select(id: string): void {
    this.ctx.selection.set({ aircraftId: id });
    this.renderSide();
    this.highlight();
  }

  private highlight(): void {
    const id = this.ctx.selection.sel.aircraftId;
    for (const [k, c] of this.cards) { c.classList.toggle('selected', k === id); c.setAttribute('aria-selected', String(k === id)); }
  }

  private renderSide(): void {
    clear(this.side);
    const a = this.aircraft;
    const sel = this.ctx.selection.sel;
    if (!a) { this.side.appendChild(h('div', { class: 'panel', style: 'padding:14px' }, h('div', { class: 'empty', text: 'Select an aircraft' }))); return; }
    const capKg = a.mass.tanks.reduce((s, t) => s + t.capacityKg, 0);
    const payloadMaxKg = Math.max(0, a.mass.stations.reduce((s, st) => s + st.maxKg, 0)) || 400;
    const u = this.ctx.settings().units;
    this.selectedName.textContent = aircraftDisplayName(a.manufacturer, a.name);
    const updateFuel = (f: number) => {
      const kg = capKg * f;
      this.fuelInfo.textContent = formatFuelQuantity(kg, u);
    };
    const updatePayload = (kg: number) => {
      const tow = a.mass.emptyMassKg + capKg * this.ctx.selection.sel.fuelFraction + kg;
      this.payloadInfo.textContent = `${formatMass(kg, u)} · takeoff weight ${formatMass(tow, u)}${tow > a.mass.maxTakeoffKg ? ' — OVER MTOW' : ''}`;
      this.payloadInfo.classList.toggle('badge-warn', tow > a.mass.maxTakeoffKg);
    };
    this.fuel = slider({ min: 0, max: 100, step: 1, value: Math.round(sel.fuelFraction * 100), label: 'Fuel', format: (v) => `${v}%`,
      onInput: (v) => { this.ctx.selection.set({ fuelFraction: v / 100 }); updateFuel(v / 100); updatePayload(this.ctx.selection.sel.payloadKg); } });
    this.payload = slider({ min: 0, max: Math.round(payloadMaxKg), step: 5, value: Math.min(payloadMaxKg, sel.payloadKg), label: 'Payload', format: (v) => formatMass(v, u),
      onInput: (v) => { this.ctx.selection.set({ payloadKg: v }); updatePayload(v); } });
    updateFuel(sel.fuelFraction); updatePayload(Math.min(payloadMaxKg, sel.payloadKg));
    this.side.append(
      h('div', { class: 'panel' }, h('div', { class: 'section-label', text: 'Selected' }), this.selectedName,
        h('p', { class: 'muted aircraft-blurb', style: 'margin:6px 0 0;font-size:.9em', text: aircraftBlurb(a) }),
        h('div', { class: 'kv', style: 'margin-top:8px' },
          h('span', { class: 'kv-k', text: 'Category' }), h('span', { class: 'kv-v', text: CATEGORY_LABEL[a.category] ?? a.category }),
          h('span', { class: 'kv-k', text: 'Landing gear' }), h('span', { class: 'kv-v', text: gearKind(a) }),
          h('span', { class: 'kv-k', text: 'Panel' }), h('span', { class: 'kv-v', text: panelKind(a) }),
          h('span', { class: 'kv-k', text: 'Autopilot' }), h('span', { class: 'kv-v', text: hasAutopilot(a) ? (a.panel.includes('g1000') ? 'GFC 700' : 'Yes (KAP 140-style)') : 'None' }),
          h('span', { class: 'kv-k', text: 'Seats' }), h('span', { class: 'kv-v', text: String(seatCount(a)) }),
          h('span', { class: 'kv-k', text: 'Empty' }), h('span', { class: 'kv-v', text: formatMass(a.mass.emptyMassKg, u) }),
          h('span', { class: 'kv-k', text: 'MTOW' }), h('span', { class: 'kv-v', text: formatMass(a.mass.maxTakeoffKg, u) }),
          h('span', { class: 'kv-k', text: 'Fuel cap.' }), h('span', { class: 'kv-v', text: `${formatFuel(capKg, u.altitude === 'ft' ? 'gal' : 'l')} (${a.mass.tanks.length} tanks)` }),
          h('span', { class: 'kv-k', text: 'Engine' }), h('span', { class: 'kv-v', text: a.propulsion.engine.type === 'piston' ? `Piston ${enginePower(a)}` : `Turbofan ${enginePower(a)}` }),
          h('span', { class: 'kv-k', text: 'Licence' }), h('span', { class: 'kv-v muted', text: a.meta.license }))),
      h('div', { class: 'panel' }, h('div', { class: 'section-label' }, icon('fuel'), ' Fuel & payload'), this.fuel.el, this.fuelInfo, h('div', { style: 'height:8px' }), this.payload.el, this.payloadInfo));
  }
}
