/**
 * World Map airport card: name, elevation, frequencies and every runway with length/width/
 * surface; pick a runway end (engines running) or "Parking (cold & dark)"; set as arrival.
 */
import type { Airport, Runway } from '../../../core/types';
import type { RunwayEndChoice } from '../../UiHost';
import type { ScreenContext } from '../Screen';
import { button, clear, h, icon } from '../../dom';
import { formatAltitude, formatCoord, formatFrequencyMHz, formatHeading, formatLength } from '../../format';
import { activeRunwayEnd, headwindKt, runwayEnds, runwayPairLabel } from '../../runways';
import { AIRPORT_TYPE_LABEL } from './AirportSearch';

const SURFACE_LABEL: Record<Runway['surface'], string> = { asphalt: 'Asphalt', concrete: 'Concrete', grass: 'Grass', gravel: 'Gravel', water: 'Water', other: 'Other' };

export interface AirportCardActions {
  /** Departure = this airport at `end` (null = parking, cold & dark). */
  chooseEnd(ap: Airport, end: RunwayEndChoice | null): void;
  /** Present only when the host supports flight-plan waypoints. */
  setArrival?: (ap: Airport | null) => void;
  /** Centre and zoom the map on the airport. */
  locate(ap: Airport): void;
}

export class AirportCard {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private ap: Airport | null = null;

  constructor(private readonly ctx: ScreenContext, private readonly actions: AirportCardActions) {
    this.body = h('div', { class: 'col', style: 'gap:8px;min-height:0;flex:1' });
    this.el = h('section', { class: 'panel airport-card', aria: { label: 'Airport' } }, this.body);
    this.render();
  }

  get airport(): Airport | null { return this.ap; }

  show(ap: Airport | null): void { this.ap = ap; this.render(); }

  /** Re-render after the selection (departure end, arrival, weather) changed. */
  refresh(): void { this.render(); }

  private render(): void {
    clear(this.body);
    const ap = this.ap;
    if (!ap) { this.body.appendChild(h('div', { class: 'empty', text: 'Select an airport on the map or search for one.' })); return; }
    const u = this.ctx.settings().units;
    const sel = this.ctx.selection.sel;
    const isDeparture = sel.spawn.airport.icao === ap.icao;
    const isArrival = sel.arrival?.icao === ap.icao;
    const where = [ap.municipality, ap.country].filter(Boolean).join(', ');

    this.body.append(
      h('div', { class: 'row' },
        h('span', { class: 'airport-icao', style: 'font-size:1.3em', text: ap.icao }),
        ap.iata ? h('span', { class: 'faint mono', text: ap.iata }) : null,
        h('span', { class: `badge${ap.type === 'large' ? ' badge-accent' : ''}`, text: AIRPORT_TYPE_LABEL[ap.type] ?? ap.type }),
        isDeparture ? h('span', { class: 'badge badge-accent', text: 'Departure' }) : null,
        isArrival ? h('span', { class: 'badge badge-ok', text: 'Arrival' }) : null,
        h('span', { class: 'spacer' }),
        button('', () => this.actions.locate(ap), { icon: 'target', cls: 'btn-ghost btn-icon btn-sm', title: 'Show on map' })),
      h('div', { class: 'aircraft-name', text: ap.name }),
      h('div', { class: 'kv' },
        where ? h('span', { class: 'kv-k', text: 'Location' }) : null, where ? h('span', { class: 'kv-v', text: where }) : null,
        h('span', { class: 'kv-k', text: 'Elevation' }), h('span', { class: 'kv-v', text: formatAltitude(ap.elevationM, u) }),
        h('span', { class: 'kv-k', text: 'Position' }), h('span', { class: 'kv-v mono', style: 'font-size:.85em', text: formatCoord(ap.position.lat, ap.position.lon) }),
        ap.frequencies?.length ? h('span', { class: 'kv-k', text: 'Radio' }) : null,
        ap.frequencies?.length ? h('span', { class: 'kv-v mono', style: 'font-size:.85em', text: ap.frequencies.slice(0, 4).map((f) => `${f.type} ${formatFrequencyMHz(f.mhz)}`).join(' · ') }) : null),
      h('div', { class: 'section-label', text: 'Departure position' }),
      h('div', { class: 'scroll col', style: 'gap:6px' }, this.runwayList(ap, isDeparture), this.parkingButton(ap, isDeparture)),
      this.footer(ap, isDeparture, isArrival));
  }

  private runwayList(ap: Airport, isDeparture: boolean): HTMLElement {
    const list = h('div', { class: 'runway-list' });
    if (ap.runways.length === 0) { list.appendChild(h('div', { class: 'empty', text: 'No runway data — start from parking.' })); return list; }
    const u = this.ctx.settings().units;
    const chosen = isDeparture ? this.ctx.selection.sel.spawn.runwayEnd : null;
    const wind = this.ctx.selection.weatherState().winds[0];
    const windKt = wind ? wind.speedKt : 0;
    const active = wind && windKt >= 5 ? activeRunwayEnd(ap, wind.directionDeg, windKt) : null;
    for (const rwy of [...ap.runways].sort((a, b) => b.lengthM - a.lengthM)) {
      const ends = runwayEnds(rwy);
      const ils = rwy.ils ? ` · ILS ${formatFrequencyMHz(rwy.ils.frequencyMHz)}` : '';
      const meta = `${formatLength(rwy.lengthM, u)} × ${formatLength(rwy.widthM, u)} · ${SURFACE_LABEL[rwy.surface] ?? rwy.surface}${rwy.lighted ? ' · lit' : ''}${ils}`;
      const hasActive = active !== null && ends.some((e) => e.endIdent === active.endIdent);
      list.appendChild(h('div', { class: 'runway-row' },
        h('div', null,
          h('div', null, h('strong', { class: 'mono', text: runwayPairLabel(rwy) }), hasActive ? h('span', { class: 'badge badge-ok', style: 'margin-left:6px', text: 'Into wind' }) : null),
          h('div', { class: 'runway-meta', text: meta })),
        ...ends.map((end) => {
          const hw = wind ? headwindKt(end, wind.directionDeg, windKt) : 0;
          const windTxt = windKt >= 1 ? ` · ${hw >= 0 ? 'headwind' : 'tailwind'} ${Math.abs(Math.round(hw))} kt` : '';
          const on = chosen !== null && chosen.endIdent === end.endIdent;
          const b = button(end.endIdent, () => this.actions.chooseEnd(ap, end), { cls: `runway-btn${on ? ' active' : ''}`, title: `Runway ${end.endIdent} · heading ${formatHeading(end.headingDeg)} true${windTxt}`, aria: { pressed: on } });
          b.appendChild(h('span', { class: 'faint', style: 'font-weight:400;font-size:.8em', text: formatHeading(end.headingDeg) }));
          return b;
        })));
    }
    return list;
  }

  private parkingButton(ap: Airport, isDeparture: boolean): HTMLElement {
    const on = isDeparture && this.ctx.selection.sel.spawn.runwayEnd === null;
    return button('Parking (cold & dark)', () => this.actions.chooseEnd(ap, null), { icon: 'flag', cls: on ? 'active' : '', title: 'Start parked with the engine off', aria: { pressed: on } });
  }

  private footer(ap: Airport, isDeparture: boolean, isArrival: boolean): HTMLElement {
    const row = h('div', { class: 'row wrap' });
    if (!isDeparture) {
      row.appendChild(button('Set as departure', () => {
        const wind = this.ctx.selection.weatherState().winds[0];
        this.actions.chooseEnd(ap, activeRunwayEnd(ap, wind?.directionDeg ?? 0, wind?.speedKt ?? 0));
      }, { primary: true, icon: 'plane', title: 'Runway into the wind (longest when calm)' }));
    }
    const setArrival = this.actions.setArrival;
    if (setArrival) {
      row.appendChild(isArrival
        ? button('Clear arrival', () => setArrival(null), { icon: 'close' })
        : button('Set as arrival', () => setArrival(ap), { icon: 'flag', disabled: isDeparture, title: isDeparture ? 'Departure and arrival are the same airport' : 'Adds a direct leg to the flight plan' }));
    }
    if (!row.firstChild) row.appendChild(h('span', { class: 'muted', style: 'font-size:.85em' }, icon('check'), ' Departure airport'));
    return row;
  }
}
