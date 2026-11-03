/**
 * MSFS-style World Map: search → airport card (runway end or parking) → flight conditions →
 * departure summary → FLY. The canvas map pans/zooms and shows airports around the view.
 */
import type { Airport } from '../../core/types';
import type { RunwayEndChoice } from '../UiHost';
import { Screen, screenHeader, type ScreenContext } from './Screen';
import { Txt, button, h } from '../dom';
import { formatDistance, formatHeading, formatLength, formatTimeLocal, timezoneOffsetFromLon } from '../format';
import { distanceM } from '../geoMath';
import { AIRPORT_FOCUS_PX_PER_DEG } from '../worldMapModel';
import { AirportSearch } from './worldmap/AirportSearch';
import { AirportCard } from './worldmap/AirportCard';
import { MapCanvas } from './worldmap/MapCanvas';
import { FlightConditions } from './worldmap/FlightConditions';

type SummaryKey = 'dep' | 'pos' | 'arr' | 'cond';

export class WorldMap extends Screen {
  private search: AirportSearch;
  private card: AirportCard;
  private map: MapCanvas;
  private conditions: FlightConditions;
  private summary = {} as Record<SummaryKey, Txt>;
  private summarySub = {} as Record<SummaryKey, Txt>;
  private focused: Airport | null = null;
  private centeredOn: string | null = null;
  private unsub: () => void;

  constructor(private readonly ctx: ScreenContext) {
    super('worldmap');
    const host = ctx.host;
    this.search = new AirportSearch(host, (ap) => this.focusAirport(ap, true), () => this.map ? { lat: this.map.currentView.centerLat, lon: this.map.currentView.centerLon, alt: 0 } : ctx.selection.sel.spawn.airport.position);
    this.card = new AirportCard(ctx, {
      chooseEnd: (ap, end) => this.chooseEnd(ap, end),
      setArrival: host.addWaypoint ? (ap) => this.setArrival(ap) : undefined,
      locate: (ap) => this.map.centerOn(ap.position.lat, ap.position.lon, Math.max(this.map.currentView.pxPerDeg, AIRPORT_FOCUS_PX_PER_DEG)),
    });
    this.map = new MapCanvas({
      host,
      units: () => ctx.settings().units,
      state: () => { const s = ctx.selection.sel; return { departure: s.spawn.airport, departureEnd: s.spawn.runwayEnd, focused: this.focused, arrival: s.arrival }; },
      onPick: (ap) => this.focusAirport(ap, false),
    });
    this.conditions = new FlightConditions(ctx);

    const cell = (k: SummaryKey, label: string) => {
      this.summary[k] = new Txt(h('div', { class: 'summary-v ellipsis' }), '--');
      this.summarySub[k] = new Txt(h('div', { class: 'summary-sub ellipsis' }), '');
      return h('div', { style: 'min-width:0' }, h('div', { class: 'summary-k', text: label }), this.summary[k].el, this.summarySub[k].el);
    };
    const summary = h('div', { class: 'panel departure-summary', aria: { label: 'Departure summary' } },
      cell('dep', 'Departure'), cell('pos', 'Position'), cell('arr', 'Arrival'), cell('cond', 'Conditions'));
    const fly = button('Fly', () => ctx.fly(), { primary: true, big: true, icon: 'plane', title: 'Start the flight (Enter on the map)' });

    this.el.append(
      screenHeader(ctx, 'World map', 'Pick a departure, set the conditions, then fly'),
      h('div', { class: 'screen-body' },
        h('aside', { class: 'wm-sidebar' }, this.search.el, this.card.el),
        h('div', { class: 'wm-center' }, this.map.el, h('div', { class: 'wm-bottom' }, summary, fly)),
        h('aside', { class: 'wm-right' }, this.conditions.el)));
    this.unsub = ctx.selection.onChange(() => { if (this.visible) this.onSelectionChanged(); });
  }

  protected override onShow(): void {
    const dep = this.ctx.selection.sel.spawn.airport;
    if (!this.focused) this.focused = dep;
    this.map.setVisible(true);
    if (this.centeredOn !== dep.icao) {
      this.centeredOn = dep.icao;
      this.map.centerOn(dep.position.lat, dep.position.lon, Math.max(120, Math.min(this.map.currentView.pxPerDeg, 2000)));
    }
    this.card.show(this.focused);
    this.search.setSelected(this.focused.icao);
    this.search.refresh();
    this.conditions.refresh();
    this.renderSummary();
    this.map.invalidate();
    this.search.input.focus({ preventScroll: true });
  }

  protected override onHide(): void { this.map.setVisible(false); }

  /** Enter on the map (not in a text field) flies, like MSFS's big button. */
  override onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Enter' && (e.target as HTMLElement | null)?.tagName === 'CANVAS') { this.ctx.fly(); return true; }
    return false;
  }

  override dispose(): void {
    this.unsub();
    this.search.dispose();
    this.conditions.dispose();
    this.map.dispose();
  }

  private focusAirport(ap: Airport, centre: boolean): void {
    this.focused = ap;
    this.card.show(ap);
    this.search.setSelected(ap.icao);
    if (centre) this.map.centerOn(ap.position.lat, ap.position.lon, AIRPORT_FOCUS_PX_PER_DEG);
    else this.map.invalidate();
  }

  private chooseEnd(ap: Airport, end: RunwayEndChoice | null): void {
    this.ctx.selection.set({ spawn: { airport: ap, runwayEnd: end, coldAndDark: end === null } });
    this.centeredOn = ap.icao;
  }

  private setArrival(ap: Airport | null): void {
    this.ctx.selection.set({ arrival: ap });
    if (!ap) { this.ctx.toast('Arrival cleared', 'info'); return; }
    if (this.ctx.inFlight() && this.ctx.host.addWaypoint) {
      this.ctx.host.addWaypoint({ id: ap.icao, position: ap.position, type: 'airport' });
      this.ctx.toast(`${ap.icao} added to the flight plan`, 'success');
    } else this.ctx.toast(`Arrival ${ap.icao} — added to the flight plan when you fly`, 'success');
  }

  private onSelectionChanged(): void {
    this.card.refresh();
    this.renderSummary();
    this.map.invalidate();
  }

  private renderSummary(): void {
    const s = this.ctx.selection.sel;
    const u = this.ctx.settings().units;
    const d = this.ctx.selection.describe();
    const end = s.spawn.runwayEnd;
    const t = s.time;
    this.summary.dep.set(s.spawn.airport.icao);
    this.summarySub.dep.set(s.spawn.airport.name);
    this.summary.pos.set(end ? `Runway ${end.endIdent}` : 'Parking');
    this.summarySub.pos.set(end ? `${formatHeading(end.headingDeg)} · ${formatLength(end.lengthM, u)}` : 'Cold & dark');
    this.summary.arr.set(s.arrival ? s.arrival.icao : '—');
    this.summarySub.arr.set(s.arrival ? `${formatDistance(distanceM(s.spawn.airport.position, s.arrival.position), u)} direct` : 'Free flight');
    this.summary.cond.set(d.weather);
    const timeName = t.mode === 'now' ? 'Now' : t.mode === 'preset' ? t.preset.charAt(0).toUpperCase() + t.preset.slice(1) : 'Custom';
    this.summarySub.cond.set(`${timeName} · ${formatTimeLocal(this.ctx.selection.resolvedTimeUtcMs(), timezoneOffsetFromLon(s.spawn.airport.position.lon))} local`);
  }
}
