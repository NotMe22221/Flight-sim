/**
 * EFB › Flight plan: departure and destination from the airport database (ICAO, IATA, name or city),
 * a cruise altitude, and "Direct" (as MSFS's World Map "Direct - GPS"): the route goes to the
 * flight planner, the G1000's FPL, the VFR map's magenta line, the nav log and ATC (which then offers
 * the destination first under "Prepare to land").
 */
import type { Airport, Geodetic, SimSnapshot, Waypoint } from '../../core/types';
import { greatCircleDistance } from '../../geo/wgs84';
import { waypointFromAirport } from '../../nav/flightPlan';
import type { UiHost } from '../UiHost';
import { Txt, button, clear, h } from '../dom';

const FT = 0.3048, NM = 1852;

/**
 * Plain-data route: departure (carrying the cruise altitude, as a .pln's en-route altitude) → destination
 * (at its field elevation).
 */
export function directRoute(dep: Airport, dest: Airport, cruiseFt: number): Waypoint[] {
  return [
    { ...waypointFromAirport(dep), altConstraintM: cruiseFt * FT },
    { ...waypointFromAirport(dest), altConstraintM: dest.elevationM },
  ];
}

/** Distance (nm) and time en route (minutes) at `cruiseKt` between two points. */
export function legSummary(a: Geodetic, b: Geodetic, cruiseKt: number): { nm: number; minutes: number } {
  const nm = greatCircleDistance(a, b) / NM;
  return { nm, minutes: cruiseKt > 0 ? (nm / cruiseKt) * 60 : 0 };
}

export class TabletFlightPlan {
  readonly el: HTMLElement;
  private dep: Airport | null = null;
  private dest: Airport | null = null;
  private cruise: HTMLInputElement;
  private summary: Txt;
  private status: Txt;
  private depField: { input: HTMLInputElement; list: HTMLElement };
  private destField: { input: HTMLInputElement; list: HTMLElement };
  private seeded = false;

  constructor(private readonly host: UiHost) {
    this.depField = this.field('Departure', (a) => { this.dep = a; this.refresh(); });
    this.destField = this.field('Destination', (a) => { this.dest = a; this.refresh(); });
    this.cruise = h('input', { class: 'input', type: 'number', min: 500, max: 45000, step: 500, value: 4500, aria: { label: 'Cruise altitude, feet' }, onInput: () => this.refresh() });
    this.summary = new Txt(h('div', { class: 'tablet-summary' }), '');
    this.status = new Txt(h('div', { class: 'muted tablet-note' }), 'Pick a destination, then Fly direct. The route shows on the map, the G1000 and the nav log.');
    this.el = h('div', { class: 'tablet-page tablet-plan' },
      h('h3', { class: 'tablet-h', text: 'Flight plan' }),
      this.depField.input.parentElement!, this.destField.input.parentElement!,
      h('label', { class: 'tablet-field' }, h('span', { text: 'Cruise altitude (ft)' }), this.cruise),
      this.summary.el,
      h('div', { class: 'row', style: 'gap:8px' },
        button('Fly direct', () => this.apply(), { primary: true, icon: 'route', title: 'Send the direct route to the GPS / flight plan' }),
        button('Swap', () => { [this.dep, this.dest] = [this.dest, this.dep]; this.fill(); this.refresh(); }, { title: 'Swap departure and destination' })),
      this.status.el);
  }

  private field(label: string, pick: (a: Airport) => void): { input: HTMLInputElement; list: HTMLElement } {
    const list = h('div', { class: 'tablet-results' });
    const input = h('input', { class: 'input', type: 'search', placeholder: 'ICAO, name or city', autocomplete: 'off', spellcheck: false, aria: { label } });
    const show = () => {
      clear(list);
      const q = input.value.trim();
      if (q.length < 2) return;
      let found: Airport[] = [];
      try { found = this.host.nav.searchAirports(q, 6); } catch { found = []; }
      for (const a of found) {
        list.appendChild(h('button', { class: 'tablet-result', type: 'button', onClick: () => { pick(a); input.value = `${a.icao} · ${a.name}`; clear(list); } },
          h('b', { text: a.icao }), h('span', { text: ` ${a.name}${a.municipality ? ', ' + a.municipality : ''}` })));
      }
    };
    input.addEventListener('input', show);
    h('label', { class: 'tablet-field' }, h('span', { text: label }), input, list);
    return { input, list };
  }

  private fill(): void {
    this.depField.input.value = this.dep ? `${this.dep.icao} · ${this.dep.name}` : '';
    this.destField.input.value = this.dest ? `${this.dest.icao} · ${this.dest.name}` : '';
  }

  private cruiseKt(): number {
    let v = 0;
    try { v = this.host.currentAircraft().limits.VnoKt * 0.9; } catch { v = 0; }
    return v > 40 ? v : 110;
  }

  private refresh(): void {
    if (!this.dep || !this.dest) { this.summary.set(''); return; }
    const s = legSummary(this.dep.position, this.dest.position, this.cruiseKt());
    const hh = Math.floor(s.minutes / 60), mm = Math.round(s.minutes % 60);
    this.summary.set(`${this.dep.icao} → ${this.dest.icao}: ${s.nm.toFixed(0)} nm, about ${hh ? `${hh} h ` : ''}${mm} min at ${Math.round(this.cruiseKt())} kt`);
  }

  private apply(): void {
    if (!this.dep || !this.dest) { this.status.set('Choose a departure and a destination first.'); return; }
    if (this.dep.icao === this.dest.icao) { this.status.set('Departure and destination are the same airport.'); return; }
    if (!this.host.setPlan) { this.status.set('Flight plans are not available.'); return; }
    const ft = Math.min(Math.max(Number(this.cruise.value) || 4500, 500), 45000);
    this.host.setPlan(directRoute(this.dep, this.dest, ft));
    this.status.set(`Direct ${this.dep.icao} → ${this.dest.icao} at ${ft.toLocaleString('en-US')} ft is loaded. Arm NAV on the autopilot to follow it.`);
  }

  /** On show: departure defaults to the nearest airport. */
  onShow(s: SimSnapshot | null): void {
    if (this.seeded || !s) return;
    let near: Airport[] = [];
    try { near = this.host.nav.nearestAirports(s.aircraft.geo, 1, 10); } catch { near = []; }
    if (near[0] && !this.dep) { this.dep = near[0]; this.fill(); this.refresh(); }
    this.seeded = true;
  }

  /** New flight: start over from the new position. */
  reset(): void { this.dep = null; this.dest = null; this.seeded = false; this.fill(); this.refresh(); this.status.set(''); }
}
