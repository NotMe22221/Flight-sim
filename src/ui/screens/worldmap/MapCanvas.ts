/**
 * World Map canvas: drag to pan, wheel to zoom about the cursor, double-click to zoom in,
 * arrows/+/- when focused. Airports come from host.nav.nearestAirports around the view centre
 * (throttled, re-queried only after a meaningful pan/zoom); small-airport shards are requested
 * with nav.loadRegion once zoomed in. Redraws on demand via requestAnimationFrame.
 */
import type { Airport } from '../../../core/types';
import type { RunwayEndChoice, UiHost, UnitsSettings } from '../../UiHost';
import { Txt, button, h } from '../../dom';
import { formatCoord } from '../../format';
import { createView, pan, resize, unproject, zoomAt, type MapView } from '../../mapProjection';
import {
  MAX_MAP_PX_PER_DEG, OVERVIEW_QUERY, ZOOM_LOAD_REGION, ZOOM_MEDIUM, airportQuery, hitTestAirport, isOverviewType, needsRefetch, scaleBar,
  type AirportQuery,
} from '../../worldMapModel';
import { drawMap } from './mapDraw';

export interface MapCanvasState { departure: Airport; departureEnd: RunwayEndChoice | null; focused: Airport | null; arrival: Airport | null }

export interface MapCanvasOptions {
  host: UiHost;
  state: () => MapCanvasState;
  units: () => UnitsSettings;
  onPick: (ap: Airport) => void;
}

const FETCH_INTERVAL_MS = 250;
const DRAG_THRESHOLD_PX = 4;
const MAX_REGION_NM = 250;

export class MapCanvas {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D | null = null;
  private view: MapView = createView(-122.4, 37.6, 120, 800, 600);
  private dpr = 1;
  /** drawn list: the global overview (large + medium) plus small fields near the centre when zoomed in */
  private airports: Airport[] = [];
  private overview: Airport[] | null = null;
  private lastQuery: AirportQuery | null = null;
  private lastFetchMs = -Infinity;
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private visible = false;
  private hover: Airport | null = null;
  private hoverTxt: Txt;
  private scaleTxt: Txt;
  private scaleBarEl: HTMLElement;
  private drag: { id: number; x: number; y: number; moved: boolean; view: MapView } | null = null;
  private ro: ResizeObserver | null = null;
  private regionsRequested = new Set<string>();
  private readonly onWindowResize = () => this.syncSize();

  constructor(private readonly o: MapCanvasOptions) {
    this.canvas = h('canvas', { tabIndex: 0, aria: { label: 'World map. Drag to pan, scroll to zoom, click an airport.' } });
    this.hoverTxt = new Txt(h('div', { class: 'wm-hover' }), '');
    this.scaleBarEl = h('span', { class: 'wm-scale-bar' });
    this.scaleTxt = new Txt(h('span'), '');
    const zoom = h('div', { class: 'wm-zoom' },
      button('', () => this.zoomBy(2), { icon: 'arrowUp', cls: 'btn-icon btn-sm', title: 'Zoom in (+)', aria: { label: 'Zoom in' } }),
      button('', () => this.zoomBy(0.5), { icon: 'chevronDown', cls: 'btn-icon btn-sm', title: 'Zoom out (−)', aria: { label: 'Zoom out' } }),
      button('', () => { const d = this.o.state().departure; this.centerOn(d.position.lat, d.position.lon, Math.max(this.view.pxPerDeg, 200)); }, { icon: 'target', cls: 'btn-icon btn-sm', title: 'Centre on departure', aria: { label: 'Centre on departure' } }));
    this.el = h('div', { class: 'wm-map' }, this.canvas, this.hoverTxt.el, zoom,
      h('div', { class: 'wm-map-overlay' }, h('div', { class: 'wm-scale' }, this.scaleBarEl, this.scaleTxt.el)));
    this.bindPointer();
  }

  get currentView(): Readonly<MapView> { return this.view; }

  /** Start/stop drawing and observing size (only while the World Map screen is visible). */
  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    if (on) {
      if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(() => this.syncSize()); this.ro.observe(this.el); }
      else window.addEventListener('resize', this.onWindowResize);
      this.syncSize();
      this.refetch(true);
    } else {
      this.ro?.disconnect(); this.ro = null;
      window.removeEventListener('resize', this.onWindowResize);
      this.cancelTimers();
      this.drag = null;
    }
  }

  /** Centre on a point; `pxPerDeg` optionally sets the zoom. */
  centerOn(lat: number, lon: number, pxPerDeg = this.view.pxPerDeg): void {
    this.view = createView(lon, lat, Math.min(MAX_MAP_PX_PER_DEG, Math.max(this.minZoom(), pxPerDeg)), this.view.width, this.view.height);
    this.changed();
  }

  /** Redraw on the next animation frame (selection/route changed). */
  invalidate(): void {
    if (!this.visible || this.raf) return;
    if (typeof requestAnimationFrame !== 'function') { this.draw(); return; }
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  /** Forces the next refresh to query the nav database again (e.g. after a shard loaded). */
  reloadAirports(): void { this.lastQuery = null; this.refetch(true); }

  dispose(): void {
    this.setVisible(false);
    this.el.remove();
  }

  // ─── view ─────────────────────────────────────────────────────────────────

  /** The whole world exactly fills the width at the minimum zoom (no empty space past ±180°). */
  private minZoom(): number { return Math.max(1, this.view.width / 360); }

  private zoomBy(f: number, x = this.view.width / 2, y = this.view.height / 2): void {
    const target = Math.min(MAX_MAP_PX_PER_DEG, Math.max(this.minZoom(), this.view.pxPerDeg * f));
    this.view = zoomAt(this.view, x, y, target / this.view.pxPerDeg);
    this.changed();
  }

  private changed(): void { this.invalidate(); this.refetch(false); }

  private syncSize(): void {
    const w = Math.max(1, this.el.clientWidth), hgt = Math.max(1, this.el.clientHeight);
    this.dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const pw = Math.round(w * this.dpr), ph = Math.round(hgt * this.dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) { this.canvas.width = pw; this.canvas.height = ph; }
    if (w !== this.view.width || hgt !== this.view.height) {
      this.view = resize(this.view, w, hgt);
      if (this.view.pxPerDeg < this.minZoom()) this.view = { ...this.view, pxPerDeg: this.minZoom() };
    }
    this.changed();
  }

  // ─── data ─────────────────────────────────────────────────────────────────

  /** Throttled nearestAirports query (leading + trailing edge). */
  private refetch(force: boolean): void {
    if (!this.visible) return;
    const q = airportQuery(this.view);
    if (!force && !needsRefetch(this.lastQuery, q)) return;
    const now = performance.now();
    const wait = this.lastFetchMs + FETCH_INTERVAL_MS - now;
    if (wait > 0 && !force) {
      if (!this.fetchTimer) this.fetchTimer = setTimeout(() => { this.fetchTimer = null; this.refetch(false); }, wait);
      return;
    }
    this.lastFetchMs = now;
    this.lastQuery = q;
    const overview = this.overviewLayer(q);
    if (q.pxPerDeg < ZOOM_MEDIUM) this.airports = overview;
    else {
      let local: Airport[] = [];
      try { local = this.o.host.nav.nearestAirports({ lat: q.lat, lon: q.lon, alt: 0 }, q.maxCount, q.radiusNm).filter((a) => !isOverviewType(a.type)); } catch { local = []; }
      this.airports = local.length ? overview.concat(local) : overview;
    }
    this.requestRegion(q);
    this.invalidate();
  }

  /**
   * Large + medium airports worldwide, fetched once (~15 ms for ~6 000 records): "nearest N to
   * the centre" alone would leave most of a world-wide view empty.
   */
  private overviewLayer(q: AirportQuery): Airport[] {
    if (this.overview && this.overview.length) return this.overview;
    try {
      this.overview = this.o.host.nav.nearestAirports({ lat: q.lat, lon: q.lon, alt: 0 }, OVERVIEW_QUERY.maxCount, OVERVIEW_QUERY.radiusNm).filter((a) => isOverviewType(a.type));
    } catch { this.overview = []; }
    return this.overview;
  }

  /** Zoomed in: ask the nav DB for small-airport shards around the centre (each 1° cell once). */
  private requestRegion(q: AirportQuery): void {
    if (q.pxPerDeg < ZOOM_LOAD_REGION) return;
    const key = `${Math.round(q.lat)},${Math.round(q.lon)}`;
    if (this.regionsRequested.has(key)) return;
    this.regionsRequested.add(key);
    this.o.host.nav.loadRegion({ lat: q.lat, lon: q.lon, alt: 0 }, Math.min(MAX_REGION_NM, q.radiusNm))
      .then(() => { if (this.visible) this.reloadAirports(); })
      .catch(() => { this.regionsRequested.delete(key); });
  }

  // ─── drawing ──────────────────────────────────────────────────────────────

  private draw(): void {
    if (!this.visible) return;
    if (!this.g) this.g = this.canvas.getContext('2d');
    const g = this.g;
    if (!g) return;
    const st = this.o.state();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawMap(g, { view: this.view, airports: this.airports, departure: st.departure, departureEnd: st.departureEnd, focused: st.focused, arrival: st.arrival, hover: this.hover });
    const sb = scaleBar(this.view, this.view.centerLat, this.o.units().distance, 110);
    this.scaleBarEl.style.width = `${Math.round(sb.px)}px`;
    this.scaleTxt.set(sb.label);
  }

  // ─── input ────────────────────────────────────────────────────────────────

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindPointer(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = this.local(e);
      this.drag = { id: e.pointerId, x: p.x, y: p.y, moved: false, view: this.view };
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      c.focus({ preventScroll: true });
    });
    c.addEventListener('pointermove', (e) => {
      const p = this.local(e);
      const d = this.drag;
      if (d && d.id === e.pointerId) {
        if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) > DRAG_THRESHOLD_PX) { d.moved = true; c.classList.add('dragging'); }
        if (d.moved) { this.view = pan(d.view, p.x - d.x, p.y - d.y); this.changed(); }
        return;
      }
      this.updateHover(p.x, p.y);
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      c.classList.remove('dragging');
      try { c.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (!d.moved && e.type === 'pointerup') {
        const p = this.local(e);
        const ap = hitTestAirport(this.airports, this.view, p.x, p.y, 10);
        if (ap) this.o.onPick(ap);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (!this.drag) { this.hover = null; this.hoverTxt.set(''); this.invalidate(); } });
    c.addEventListener('dblclick', (e) => { const p = this.local(e); this.zoomBy(2, p.x, p.y); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this.local(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      this.zoomBy(Math.exp(-Math.max(-600, Math.min(600, dy)) * 0.0018), p.x, p.y);
    }, { passive: false });
    c.addEventListener('keydown', (e) => this.onKey(e));
  }

  private updateHover(x: number, y: number): void {
    const ap = hitTestAirport(this.airports, this.view, x, y, 10);
    if (ap !== this.hover) { this.hover = ap; this.invalidate(); }
    if (ap) this.hoverTxt.set(`${ap.icao} · ${ap.name}`);
    else { const ll = unproject(this.view, x, y); this.hoverTxt.set(formatCoord(ll.lat, ll.lon)); }
  }

  private onKey(e: KeyboardEvent): void {
    const step = 60;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': this.view = pan(this.view, step, 0); this.changed(); break;
      case 'ArrowRight': this.view = pan(this.view, -step, 0); this.changed(); break;
      case 'ArrowUp': this.view = pan(this.view, 0, step); this.changed(); break;
      case 'ArrowDown': this.view = pan(this.view, 0, -step); this.changed(); break;
      case '+': case '=': this.zoomBy(2); break;
      case '-': case '_': this.zoomBy(0.5); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  private cancelTimers(): void {
    if (this.fetchTimer) { clearTimeout(this.fetchTimer); this.fetchTimer = null; }
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
