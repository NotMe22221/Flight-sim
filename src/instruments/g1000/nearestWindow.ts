/**
 * Nearest airports / VORs / NDBs (MFD NRST pages, PFD NRST window). Airports list bearing
 * (magnetic) and distance, the longest runway, the CTAF or tower frequency and an ILS flag; the
 * selected airport's frequencies can be picked with the outer knob and loaded into the COM1
 * standby with ENT. ENT on an airport (or D→) opens Direct-To prefilled with it; ENT on a VOR
 * loads its frequency into the NAV1 standby. The list refreshes every 2 s.
 */
import type { Airport, Navaid } from '../../core/types';
import { ilsApproaches } from '../../nav';
import type { Ctx2D } from '../canvas';
import { DirectToWindow } from './directTo';
import { type FmsContext, type FmsEvent, FmsWindow, type FmsTarget, type Rect, type WindowDrawData, bearingDegGeo, distanceNmGeo, targetFromAirport, targetFromNavaid } from './fmsCore';
import { brgDis, cell, clip, comLabels, navLabels, ndbLabels, windowFrame, winStyle } from './fmsDraw';
import { G } from './palette';
import { text } from './widgets';

export type NearestKind = 'apt' | 'vor' | 'ndb';

/** How many entries each nearest list holds, and its search radius (nm). */
export const NRST_COUNT = 25;
export const NRST_RADIUS_NM = 200;
/** Refresh period of the lists, s. */
export const NRST_REFRESH_S = 2;
/** Frequencies listed (and selectable) for the selected airport. */
const DETAIL_FREQS = 3;

interface FreqInfo { type: string; kHz: number; label: string }
interface AptInfo { name: string; rwy: string; ils: boolean; freqs: FreqInfo[]; best: FreqInfo | null }
const aptCache = new WeakMap<Airport, AptInfo>();
const FREQ_RANK: Record<string, number> = { TWR: 0, CTAF: 1, UNIC: 2, AFIS: 3, 'A/G': 4, GND: 5, ATIS: 6, AWOS: 7, ASOS: 7, APP: 8, DEP: 9 };

/** Derived display strings for an airport (built once per airport). */
export function airportInfo(a: Airport): AptInfo {
  let info = aptCache.get(a);
  if (info) return info;
  let longest = 0, surf = '';
  for (const r of a.runways) if (r.lengthM > longest) { longest = r.lengthM; surf = r.surface; }
  const freqs: FreqInfo[] = [];
  for (const f of a.frequencies ?? []) {
    const kHz = Math.round(f.mhz * 1000);
    if (kHz < 118_000 || kHz > 136_990) continue; // COM band only
    const type = f.type.toUpperCase();
    freqs.push({ type, kHz, label: `${clip(type, 4)} ${comLabels.get(kHz)}` });
  }
  freqs.sort((x, y) => (FREQ_RANK[x.type] ?? 20) - (FREQ_RANK[y.type] ?? 20));
  let ils = false;
  try { ils = ilsApproaches(a).length > 0; } catch { ils = false; }
  info = {
    name: clip(a.name, 30),
    rwy: longest > 0 ? `${Math.round(longest / 0.3048 / 10) * 10}FT ${surf === 'asphalt' || surf === 'concrete' ? 'HARD' : surf.toUpperCase()}` : '',
    ils, freqs, best: freqs.length ? freqs[0] : null,
  };
  aptCache.set(a, info);
  return info;
}

export class NearestWindow extends FmsWindow {
  readonly kind = 'nrst' as const;
  override live = true;
  cursor: boolean;
  sel = 0;
  top = 0;
  /** airports: 'list' or the selected airport's frequency list */
  focus: 'list' | 'freq' = 'list';
  freqSel = 0;
  airports: readonly Airport[] = [];
  navaids: readonly Navaid[] = [];
  private age = Infinity;

  constructor(fms: FmsContext, public type: NearestKind, cursor = true) {
    super(fms);
    this.cursor = cursor;
  }

  get count(): number { return this.type === 'apt' ? this.airports.length : this.navaids.length; }

  /** Only with the cursor on do ENT / CLR do anything here. */
  override takesKeys(): boolean { return this.cursor; }

  setType(t: NearestKind): void {
    if (t === this.type) return;
    this.type = t; this.sel = 0; this.top = 0; this.focus = 'list'; this.age = Infinity;
    this.refresh(0);
  }

  override refresh(dt: number): void {
    this.age += dt;
    if (this.age < NRST_REFRESH_S) return;
    this.age = 0;
    const nav = this.fms.nav;
    if (!nav) { this.airports = []; this.navaids = []; return; }
    const keep = this.selection();
    if (this.type === 'apt') this.airports = nav.nearestAirports(this.fms.pos, NRST_COUNT, NRST_RADIUS_NM);
    else {
      const all = nav.nearestNavaids(this.fms.pos, NRST_COUNT * 3, NRST_RADIUS_NM);
      const want = this.type === 'ndb';
      this.navaids = all.filter((n) => (n.type === 'NDB') === want && n.type !== 'DME').slice(0, NRST_COUNT);
    }
    // keep the cursor on the same station while the order changes
    if (keep) {
      const i = this.type === 'apt' ? this.airports.findIndex((a) => a.icao === keep.ident) : this.navaids.findIndex((n) => n.id === keep.ident);
      if (i >= 0) this.sel = i;
    }
    this.sel = Math.min(this.sel, Math.max(0, this.count - 1));
    this.fms.touch();
  }

  override selection(): FmsTarget | null {
    if (this.type === 'apt') { const a = this.airports[this.sel]; return a ? targetFromAirport(a) : null; }
    const n = this.navaids[this.sel];
    return n ? targetFromNavaid(n) : null;
  }

  input(e: FmsEvent): boolean {
    if (e.key === 'push') { this.cursor = !this.cursor; this.focus = 'list'; return true; }
    if (!this.cursor) return false;
    const freqs = this.type === 'apt' && this.airports[this.sel] ? airportInfo(this.airports[this.sel]).freqs : null;
    switch (e.key) {
      case 'inner':
        if (this.focus === 'freq' && freqs) this.freqSel = clampInt(this.freqSel + e.steps, 0, Math.min(DETAIL_FREQS, freqs.length) - 1);
        else { this.sel = clampInt(this.sel + e.steps, 0, Math.max(0, this.count - 1)); this.freqSel = 0; }
        return true;
      case 'outer':
        if (this.type === 'apt' && freqs && freqs.length) this.focus = this.focus === 'list' ? 'freq' : 'list';
        else this.sel = clampInt(this.sel + e.steps, 0, Math.max(0, this.count - 1));
        return true;
      case 'ENT': {
        if (this.focus === 'freq' && freqs && freqs[this.freqSel]) { this.fms.comStandby(1, freqs[this.freqSel].kHz); return true; }
        const t = this.selection();
        if (!t) return true;
        if (t.kind === 'vor' && t.frequencyKHz > 0) this.fms.emit({ kind: 'navStandby', radio: 1, kHz: t.frequencyKHz });
        else this.fms.open(this.display, new DirectToWindow(this.fms, t));
        return true;
      }
      case 'CLR':
        if (this.focus === 'freq') this.focus = 'list'; else if (this.display === 'pfd') this.fms.close(this); else this.cursor = false;
        return true;
      default: return true;
    }
  }

  draw(ctx: Ctx2D, rc: Rect, d: WindowDrawData): void {
    const st = winStyle(d.compact), h = st.rowH, x = rc.x + st.pad, w = rc.w - 2 * st.pad;
    const title = this.type === 'apt' ? 'NEAREST AIRPORTS' : this.type === 'vor' ? 'NEAREST VOR' : 'NEAREST NDB';
    let y = windowFrame(ctx, rc, title, st);
    if (!this.fms.nav) { text(ctx, 'NO NAV DATABASE', rc.x + rc.w / 2, y + 1, st.font, G.white, 'center'); return; }
    if (!this.count) { text(ctx, 'NONE WITHIN 200NM', rc.x + rc.w / 2, y + 1, st.font, G.white, 'center'); return; }
    const pos = this.fms.pos, mv = this.fms.magVarDeg;
    const apt = this.type === 'apt', perRow = apt && !d.compact ? 2 : 1;
    const detailH = apt && !d.compact ? h * 6.5 : 0;
    const rows = Math.max(1, Math.floor((rc.y + rc.h - y - detailH - h * 0.2) / (h * perRow)));
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + rows) this.top = this.sel - rows + 1;
    for (let i = this.top; i < this.count && i < this.top + rows; i++, y += h * perRow) {
      const selRow = this.cursor && this.sel === i && this.focus === 'list';
      if (apt) {
        const a = this.airports[i], info = airportInfo(a);
        cell(ctx, a.icao, x, y, 70, h - 2, st.bold, G.cyan, selRow);
        brgDis(ctx, bearingDegGeo(pos, a.position) - mv, distanceNmGeo(pos, a.position), x + w * 0.62, x + w * 0.86, y, st, G.white);
        if (info.ils) text(ctx, 'ILS', x + w, y + 1, st.small, G.green, 'right');
        if (perRow === 2) {
          text(ctx, info.rwy, x + 8, y + h + 1, st.small, G.white, 'left');
          if (info.best) text(ctx, info.best.label, x + w, y + h + 1, st.small, G.white, 'right');
        } else if (info.best) text(ctx, comLabels.get(info.best.kHz), x + 80, y + 1, st.small, G.white, 'left');
      } else {
        const n = this.navaids[i];
        cell(ctx, n.id, x, y, 60, h - 2, st.bold, G.cyan, selRow);
        text(ctx, this.type === 'vor' ? navLabels.get(n.frequencyKHz) : ndbLabels.get(n.frequencyKHz), x + 70, y + 1, st.small, G.green, 'left');
        brgDis(ctx, bearingDegGeo(pos, n.position) - mv, distanceNmGeo(pos, n.position), x + w * 0.7, x + w, y, st, G.white);
      }
    }
    if (detailH) this.drawDetail(ctx, rc, d, rc.y + rc.h - detailH);
  }

  /** Selected airport: name, runway and its frequencies (selectable with the outer knob). */
  private drawDetail(ctx: Ctx2D, rc: Rect, d: WindowDrawData, y0: number): void {
    const a = this.airports[this.sel];
    if (!a) return;
    const st = winStyle(d.compact), h = st.rowH, x = rc.x + st.pad, w = rc.w - 2 * st.pad, info = airportInfo(a);
    ctx.strokeStyle = G.grey; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(rc.x + 4, y0); ctx.lineTo(rc.x + rc.w - 4, y0); ctx.stroke();
    let y = y0 + h / 2 + 2;
    text(ctx, info.name, x, y + 1, st.small, G.white, 'left'); y += h;
    text(ctx, info.rwy, x, y + 1, st.small, G.white, 'left'); y += h;
    text(ctx, 'FREQUENCIES', x, y + 1, st.small, G.grey, 'left'); y += h;
    for (let i = 0; i < info.freqs.length && i < DETAIL_FREQS; i++, y += h) {
      const f = info.freqs[i];
      cell(ctx, f.label, x, y, w, h - 2, st.font, G.white, this.cursor && this.focus === 'freq' && this.freqSel === i);
    }
  }
}

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)));
