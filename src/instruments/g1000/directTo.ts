/**
 * Direct-To window (D→ key): a cursor-edited ident field with spell'n'find completion and a
 * nearest-match list from the nav database, the selected waypoint's name, bearing and
 * distance, and "ACTIVATE?". Flow (G1000): D→ · inner knob/keyboard to spell the ident · ENT
 * (accept) · ENT (activate). The outer knob moves the character cursor while spelling and moves
 * between the ident, the match list and ACTIVATE otherwise. CLR clears the entry or closes the
 * window; MENU offers "CANCEL DIRECT-TO NAV".
 */
import type { IdentMatch } from '../../nav';
import type { Ctx2D } from '../canvas';
import { ConfirmWindow } from './fmsWindows';
import { type FmsContext, type FmsEvent, FmsWindow, type FmsTarget, IdentField, type Rect, type WindowDrawData, bearingDegGeo, distanceNmGeo, targetFromMatch } from './fmsCore';
import { KIND_LABEL, brgDis, button, cell, clip, identCell, windowFrame, winStyle } from './fmsDraw';
import { G } from './palette';
import { text } from './widgets';

/** Matches listed under the ident field. */
export const DIRECT_MATCHES = 5;

export class DirectToWindow extends FmsWindow {
  readonly kind = 'direct' as const;
  override live = true;
  readonly field = new IdentField(6);
  target: FmsTarget | null = null;
  matches: readonly IdentMatch[] = [];
  /** 0 = ident, 1…n = match rows, n + 1 = ACTIVATE */
  focus = 0;
  message = '';
  private nameLine = '';

  constructor(fms: FmsContext, prefill: FmsTarget | null = null) {
    super(fms);
    if (prefill) { this.setTarget(prefill); this.focus = this.activateIndex; }
    else this.field.reset('');
  }

  get activateIndex(): number { return this.matches.length + 1; }

  override editing(): boolean { return this.focus === 0; }
  override selection(): FmsTarget | null { return this.target; }

  input(e: FmsEvent): boolean {
    const n = this.matches.length;
    this.message = '';
    switch (e.key) {
      case 'inner':
        if (this.focus === 0) { this.field.turn(e.steps); this.search(); }
        else if (this.focus <= n) this.focus = clampInt(this.focus + e.steps, 1, n);
        return true;
      case 'outer':
        if (this.focus === 0 && this.field.active) { this.field.move(e.steps); this.search(); }
        else this.focus = clampInt(this.focus + e.steps, 0, this.activateIndex);
        return true;
      case 'char':
        this.focus = 0;
        if (this.field.type(e.char)) this.search();
        return true;
      case 'ENT':
        if (this.focus === 0) {
          if (!this.target) { this.message = this.field.text ? 'NO MATCH' : 'ENTER IDENT'; return true; }
          this.setTarget(this.target);
          this.focus = this.activateIndex;
        } else if (this.focus <= n) {
          this.setTarget(targetFromMatch(this.matches[this.focus - 1]));
          this.focus = this.activateIndex;
        } else if (this.target) {
          if (this.fms.directTo(this.target)) this.fms.close(this);
          else this.message = 'NO FLIGHT PLANNER';
        } else this.message = 'ENTER IDENT';
        return true;
      case 'CLR':
        if (this.field.active) { this.field.reset(''); this.target = null; this.matches = []; this.focus = 0; this.nameLine = ''; }
        else this.fms.close(this);
        return true;
      case 'MENU': {
        const p = this.fms.planner;
        if (p && p.isDirectTo) this.fms.open(this.display, new ConfirmWindow(this.fms, 'CANCEL DIRECT-TO NAV?', () => p.cancelDirectTo()));
        return true;
      }
      case 'push':
        this.fms.close(this);
        return true;
    }
    return false;
  }

  /** Re-run the identifier search for the entered prefix. */
  private search(): void {
    const q = this.field.text;
    this.matches = q ? this.fms.search(q, DIRECT_MATCHES) : [];
    this.field.completion = this.matches.length ? this.matches[0].ident : '';
    this.target = this.matches.length ? targetFromMatch(this.matches[0]) : null;
    this.nameLine = this.target ? describe(this.target) : '';
  }

  private setTarget(t: FmsTarget): void {
    this.target = t;
    this.field.reset(t.ident);
    this.matches = [];
    this.nameLine = describe(t);
  }

  draw(ctx: Ctx2D, rc: Rect, d: WindowDrawData): void {
    const st = winStyle(d.compact), h = st.rowH, x = rc.x + st.pad, w = rc.w - 2 * st.pad;
    let y = windowFrame(ctx, rc, 'DIRECT TO', st);
    text(ctx, 'WPT', x, y + 1, st.small, G.white, 'left');
    identCell(ctx, this.field, x + 44, y, 92, h - 2, st, this.focus === 0);
    if (this.target) text(ctx, KIND_LABEL[this.target.kind] ?? '', x + w, y + 1, st.small, G.white, 'right');
    y += h;
    if (this.nameLine) text(ctx, this.nameLine, x, y + 1, st.small, G.white, 'left');
    y += h;
    const pos = this.fms.pos, t = this.target;
    text(ctx, 'BRG', x, y + 1, st.small, G.white, 'left');
    text(ctx, 'DIS', x + w / 2, y + 1, st.small, G.white, 'left');
    const brg = t ? bearingDegGeo(pos, t.position) - this.fms.magVarDeg : NaN, dis = t ? distanceNmGeo(pos, t.position) : NaN;
    brgDis(ctx, brg, dis, x + w / 2 - 12, x + w, y, st, G.cyan);
    y += h;
    const n = this.matches.length;
    if (n) {
      text(ctx, 'NEAREST MATCHES', x, y + 1, st.small, G.grey, 'left');
      y += h;
      for (let i = 0; i < n && y < rc.y + rc.h - 2.2 * h; i++, y += h) {
        const m = this.matches[i], sel = this.focus === i + 1;
        cell(ctx, m.ident, x, y, 80, h - 2, st.bold, G.white, sel);
        text(ctx, KIND_LABEL[m.kind] ?? '', x + 92, y + 1, st.small, G.white, 'left');
        brgDis(ctx, bearingDegGeo(pos, m.position) - this.fms.magVarDeg, m.distanceM / 1852, x + w - 80, x + w, y, st, G.white);
      }
    }
    const by = rc.y + rc.h - h;
    if (this.message) text(ctx, this.message, x, by - h + 1, st.small, G.amber, 'left');
    button(ctx, 'ACTIVATE?', rc.x + rc.w / 2, by, 120, st, this.focus === this.activateIndex);
  }
}

const describe = (t: FmsTarget): string => clip(t.name || t.ident, 34);
const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)));
