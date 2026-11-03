/**
 * World Map search: debounced host.nav.searchAirports (ICAO, IATA, name, city) with a keyboard-
 * navigable result list; an empty box lists airports near the map centre instead.
 */
import type { Airport, Geodetic } from '../../../core/types';
import type { UiHost } from '../../UiHost';
import { Txt, clear, h, icon } from '../../dom';
import { DebouncedSearch } from '../../searchDebounce';

export const AIRPORT_TYPE_LABEL: Record<Airport['type'], string> = { large: 'Large', medium: 'Medium', small: 'Small', heliport: 'Heliport', seaplane: 'Seaplane' };

const RESULT_LIMIT = 30;
const NEARBY_COUNT = 15;
const NEARBY_NM = 150;

export class AirportSearch {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private list: HTMLElement;
  private heading: Txt;
  private items: { ap: Airport; el: HTMLElement }[] = [];
  private highlight = -1;
  private selectedIcao: string | null = null;
  private search: DebouncedSearch<Airport>;

  /**
   * @param onPick called when a result is chosen (click or Enter)
   * @param nearbyCenter where "nearby" airports are measured from when the box is empty
   */
  constructor(private readonly host: UiHost, private readonly onPick: (ap: Airport) => void, private readonly nearbyCenter: () => Geodetic) {
    this.input = h('input', { class: 'input', type: 'search', placeholder: 'Search ICAO, airport or city…', autocomplete: 'off', spellcheck: false, aria: { label: 'Search airports' } });
    this.list = h('div', { class: 'airport-list scroll', role: 'listbox', aria: { label: 'Airports' } });
    this.heading = new Txt(h('div', { class: 'section-label' }), 'Nearby');
    this.search = new DebouncedSearch<Airport>({
      search: (q) => this.host.nav.searchAirports(q, RESULT_LIMIT),
      onResults: (q, r) => { if (q) this.render(r, `Results · ${r.length}${r.length === RESULT_LIMIT ? '+' : ''}`, `No airport matches “${q}”`); else this.showNearby(); },
      onError: (_q, e) => console.warn('[ui] airport search failed', e),
      delayMs: 180,
    });
    this.input.addEventListener('input', () => this.search.input(this.input.value));
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.el = h('div', { class: 'panel col', style: 'padding:12px;gap:6px' },
      h('div', { class: 'wm-search' }, icon('search'), this.input), this.heading.el, this.list);
  }

  /** Re-lists nearby airports when the box is empty (call on screen show). */
  refresh(): void {
    if (this.input.value.trim() === '') this.showNearby();
  }

  /** Marks the airport shown in the card. */
  setSelected(icao: string | null): void {
    this.selectedIcao = icao;
    for (const it of this.items) {
      const on = it.ap.icao === icao;
      it.el.classList.toggle('selected', on);
      it.el.setAttribute('aria-selected', String(on));
    }
  }

  dispose(): void { this.search.dispose(); }

  private showNearby(): void {
    let near: Airport[] = [];
    try { near = this.host.nav.nearestAirports(this.nearbyCenter(), NEARBY_COUNT, NEARBY_NM); } catch { near = []; }
    this.render(near, 'Nearby', 'No airports nearby — try the search box');
  }

  private render(list: Airport[], heading: string, emptyText: string): void {
    this.heading.set(heading);
    clear(this.list);
    this.items = [];
    this.highlight = -1;
    if (list.length === 0) { this.list.appendChild(h('div', { class: 'empty', text: emptyText })); return; }
    for (const ap of list) {
      const where = [ap.municipality, ap.country].filter(Boolean).join(', ');
      const el = h('button', { class: 'airport-item', type: 'button', role: 'option', title: `${ap.name}${where ? ' — ' + where : ''}`, onClick: () => this.pick(ap) },
        h('span', { class: 'airport-icao', text: ap.icao }),
        h('span', { class: 'airport-name' }, ap.name, where ? h('span', { class: 'faint', text: ` · ${where}` }) : null),
        h('span', { class: 'airport-type', text: AIRPORT_TYPE_LABEL[ap.type] ?? ap.type }));
      this.items.push({ ap, el });
      this.list.appendChild(el);
    }
    this.setSelected(this.selectedIcao);
  }

  private pick(ap: Airport): void {
    this.setSelected(ap.icao);
    this.onPick(ap);
  }

  private moveHighlight(dir: 1 | -1): void {
    if (!this.items.length) return;
    this.items[this.highlight]?.el.classList.remove('hover');
    this.highlight = (this.highlight + dir + this.items.length) % this.items.length;
    const it = this.items[this.highlight];
    it.el.classList.add('hover');
    it.el.scrollIntoView({ block: 'nearest' });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.moveHighlight(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      this.search.flush();
      const it = this.items[this.highlight] ?? this.items[0];
      if (it) this.pick(it.ap);
      return;
    }
    if (e.key === 'Escape' && this.input.value !== '') {
      // first Esc clears the box; the next one goes back (UiManager skips defaultPrevented keys)
      e.preventDefault();
      this.input.value = '';
      this.search.input('');
    }
  }
}
