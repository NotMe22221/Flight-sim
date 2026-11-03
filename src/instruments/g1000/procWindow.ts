/**
 * PROC window: SELECT APPROACH at the destination (else the D→ airport, else the nearest; the
 * airport ident can be re-spelled), a list of the airport's ILS approaches, then LOAD? or
 * ACTIVATE?. Loading appends the approach fixes (FFxx, RWxx) to the flight plan and tunes the
 * localizer into NAV1 with its course; ACTIVATE also goes direct to the FAF and switches the CDI
 * to NAV1 (LOAD arms the automatic GPS → LOC switch on the final course instead).
 */
import type { Airport } from '../../core/types';
import { type ApproachInfo, ilsApproaches } from '../../nav';
import type { Ctx2D } from '../canvas';
import { type FmsContext, type FmsEvent, FmsWindow, IdentField, type Rect, type WindowDrawData } from './fmsCore';
import { button, cell, clip, identCell, navLabels, windowFrame, winStyle } from './fmsDraw';
import { G } from './palette';
import { text } from './widgets';

export class ProcWindow extends FmsWindow {
  readonly kind = 'proc' as const;
  readonly field = new IdentField(4);
  airport: Airport | null = null;
  approaches: ApproachInfo[] = [];
  /** 0 airport ident, 1…n approaches, n + 1 LOAD?, n + 2 ACTIVATE? */
  focus = 0;
  /** chosen approach (index into `approaches`), −1 before one is picked */
  chosen = -1;
  message = '';
  private airportName = '';
  private rowLabels: string[] = [];

  constructor(fms: FmsContext) {
    super(fms);
    this.setAirport(fms.procAirport());
    if (this.approaches.length) this.focus = 1;
  }

  get loadIndex(): number { return this.approaches.length + 1; }
  get activateIndex(): number { return this.approaches.length + 2; }

  /** Typing re-spells the airport. */
  override editing(): boolean { return true; }

  setAirport(a: Airport | null): void {
    this.airport = a;
    this.field.reset(a ? a.icao : '');
    this.approaches = a ? ilsApproaches(a) : [];
    this.rowLabels = this.approaches.map((x) => `${x.name}  ${x.ident}`);
    this.airportName = a ? clip(a.name, 30) : '';
    this.chosen = -1;
    this.message = a && !this.approaches.length ? 'NO ILS APPROACHES' : '';
  }

  input(e: FmsEvent): boolean {
    const n = this.approaches.length;
    switch (e.key) {
      case 'inner':
        if (this.focus === 0) { this.field.turn(e.steps); this.searchAirport(); }
        else if (this.focus <= n) this.focus = clampInt(this.focus + e.steps, 1, n);
        else this.focus = this.focus === this.loadIndex ? this.activateIndex : this.loadIndex;
        return true;
      case 'outer':
        if (this.focus === 0 && this.field.active) { this.field.move(e.steps); this.searchAirport(); }
        else this.focus = clampInt(this.focus + e.steps, 0, this.chosen >= 0 ? this.activateIndex : Math.max(n, 0));
        return true;
      case 'char':
        this.focus = 0;
        if (this.field.type(e.char)) this.searchAirport();
        return true;
      case 'ENT':
        if (this.focus === 0) {
          const id = this.field.completion || this.field.text;
          const a = id && this.fms.nav ? this.fms.nav.getAirport(id) ?? null : null;
          if (!a) { this.message = 'AIRPORT NOT FOUND'; return true; }
          this.setAirport(a);
          this.focus = this.approaches.length ? 1 : 0;
        } else if (this.focus <= n) { this.chosen = this.focus - 1; this.focus = this.loadIndex; }
        else if (this.chosen >= 0) { this.fms.loadApproach(this.approaches[this.chosen], this.focus === this.activateIndex); this.fms.close(this); }
        return true;
      case 'CLR':
        if (this.field.active) { this.setAirport(this.airport); this.focus = this.approaches.length ? 1 : 0; }
        else this.fms.close(this);
        return true;
      case 'push': this.fms.close(this); return true;
      default: return true;
    }
  }

  private searchAirport(): void {
    const q = this.field.text;
    let best = '';
    if (q) for (const m of this.fms.search(q, 8)) if (m.kind === 'airport') { best = m.ident; break; }
    this.field.completion = best;
    this.message = '';
  }

  draw(ctx: Ctx2D, rc: Rect, d: WindowDrawData): void {
    const st = winStyle(d.compact), h = st.rowH, x = rc.x + st.pad, w = rc.w - 2 * st.pad;
    let y = windowFrame(ctx, rc, 'PROCEDURES - SELECT APPROACH', st);
    text(ctx, 'APT', x, y + 1, st.small, G.white, 'left');
    identCell(ctx, this.field, x + 44, y, 70, h - 2, st, this.focus === 0);
    y += h;
    if (this.airportName) text(ctx, this.airportName, x, y + 1, st.small, G.white, 'left');
    y += h;
    text(ctx, 'APPROACH', x, y + 1, st.small, G.grey, 'left');
    text(ctx, 'LOC', x + w, y + 1, st.small, G.grey, 'right');
    y += h;
    const n = this.approaches.length;
    const maxRows = Math.max(1, Math.floor((rc.y + rc.h - y - h * 2.6) / h));
    const first = Math.max(0, Math.min(n - maxRows, (this.focus >= 1 && this.focus <= n ? this.focus - 1 : Math.max(this.chosen, 0)) - maxRows + 1));
    for (let i = first; i < n && i < first + maxRows; i++, y += h) {
      const a = this.approaches[i];
      cell(ctx, this.rowLabels[i], x, y, w * 0.7, h - 2, st.bold, i === this.chosen ? G.green : G.white, this.focus === i + 1);
      text(ctx, navLabels.get(a.frequencyKHz), x + w, y + 1, st.font, G.green, 'right');
    }
    const by = rc.y + rc.h - h;
    if (this.message) text(ctx, this.message, x, by - h + 1, st.small, G.amber, 'left');
    if (this.chosen >= 0) {
      button(ctx, 'LOAD?', rc.x + rc.w * 0.3, by, 100, st, this.focus === this.loadIndex);
      button(ctx, 'ACTIVATE?', rc.x + rc.w * 0.7, by, 110, st, this.focus === this.activateIndex);
    } else if (n) text(ctx, 'SELECT AN APPROACH · ENT', rc.x + rc.w / 2, by, st.small, G.grey, 'center');
  }
}

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)));
