/**
 * Drawing helpers for the FMS windows and pages: framed windows with a title, table rows, the
 * cyan reverse-video cursor, ident fields with the character cursor, and cached number labels.
 */
import { wrap360 } from '../../core/math';
import { formatComFrequency, formatEte, formatHeadingNum, formatNavFrequency } from '../format';
import { LabelCache } from '../labelCache';
import type { Ctx2D } from '../canvas';
import type { IdentField, Rect } from './fmsCore';
import { G, cond, condBold } from './palette';
import { text } from './widgets';

/** Type scale: MFD pages and PFD (compact) windows. */
export interface WinStyle { rowH: number; font: string; bold: string; small: string; title: string; pad: number; charW: number; nameChars: number }
const MFD_STYLE: WinStyle = { rowH: 24, font: cond.get(17), bold: condBold.get(17), small: cond.get(14), title: condBold.get(16), pad: 8, charW: 11, nameChars: 30 };
const PFD_STYLE: WinStyle = { rowH: 20, font: cond.get(15), bold: condBold.get(15), small: cond.get(13), title: condBold.get(15), pad: 6, charW: 10, nameChars: 34 };
export const winStyle = (compact: boolean): WinStyle => (compact ? PFD_STYLE : MFD_STYLE);

/** Opaque window with a grey border and a centred title; returns the y of the first content row centre. */
export function windowFrame(ctx: Ctx2D, rc: Rect, title: string, st: WinStyle): number {
  ctx.fillStyle = G.black; ctx.fillRect(rc.x, rc.y, rc.w, rc.h);
  ctx.strokeStyle = G.grey; ctx.lineWidth = 1.5; ctx.strokeRect(rc.x + 0.75, rc.y + 0.75, rc.w - 1.5, rc.h - 1.5);
  const th = st.rowH;
  ctx.fillStyle = '#1d2a36'; ctx.fillRect(rc.x + 1.5, rc.y + 1.5, rc.w - 3, th);
  text(ctx, title, rc.x + rc.w / 2, rc.y + 1.5 + th / 2, st.title, G.cyan, 'center');
  return rc.y + th + 4 + st.rowH / 2;
}

/** Cyan reverse-video cursor cell. */
export function cursorCell(ctx: Ctx2D, x: number, yc: number, w: number, h: number): void {
  ctx.fillStyle = G.cyan; ctx.fillRect(x, yc - h / 2, w, h);
}

/** Text in a cell that may hold the cursor (black on cyan when selected). */
export function cell(ctx: Ctx2D, s: string, x: number, yc: number, w: number, h: number, font: string, color: string, selected: boolean, align: CanvasTextAlign = 'left'): void {
  if (selected) cursorCell(ctx, x, yc, w, h);
  const tx = align === 'left' ? x + 4 : align === 'right' ? x + w - 4 : x + w / 2;
  text(ctx, s, tx, yc + 1, font, selected ? G.black : color, align);
}

/**
 * An ident field: while editing, the character under the cursor is reverse video and the
 * auto-completed remainder is dimmed; when merely selected the whole field is reverse video.
 */
export function identCell(ctx: Ctx2D, f: IdentField, x: number, yc: number, w: number, h: number, st: WinStyle, focused: boolean, color: string = G.cyan): void {
  const shown = f.shown || '_____';
  if (!focused || !f.active) { cell(ctx, shown, x, yc, w, h, st.bold, color, focused); return; }
  const cw = st.charW;
  for (let i = 0; i < Math.max(shown.length, f.pos + 1); i++) {
    const ch = shown[i] ?? '_';
    const cx = x + 4 + i * cw;
    if (i === f.pos) { cursorCell(ctx, cx - 1, yc, cw + 1, h - 4); text(ctx, ch, cx + cw / 2, yc + 1, st.bold, G.black, 'center'); }
    else text(ctx, ch, cx + cw / 2, yc + 1, st.bold, i < f.text.length ? G.cyan : G.grey, 'center');
  }
}

/** Upper-case `s` cut to `n` characters (done when list data is built, never per frame). */
export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s).toUpperCase();

export const disLabels = new LabelCache((v) => (Number.isFinite(v) ? (v < 100 ? v.toFixed(1) : String(Math.round(v))) + 'NM' : '___NM'), 0.1);
export const brgLabels = new LabelCache((v) => (Number.isFinite(v) ? formatHeadingNum(wrap360(v)) + '°' : '___°'));
export const eteLabels = new LabelCache((v) => (Number.isFinite(v) && v >= 0 ? formatEte(v) : '__:__'));
export const ftLabels = new LabelCache((v) => `${v}FT`);
export const comLabels = new LabelCache(formatComFrequency, 1);
export const navLabels = new LabelCache(formatNavFrequency, 10);
export const ndbLabels = new LabelCache((v) => (v > 0 ? `${Math.round(v)}` : '---'));

/** Bearing (magnetic) and distance text pair for a row. */
export function brgDis(ctx: Ctx2D, brgMag: number, dis: number, xBrg: number, xDis: number, yc: number, st: WinStyle, color: string): void {
  text(ctx, brgLabels.get(brgMag), xBrg, yc + 1, st.font, color, 'right');
  text(ctx, disLabels.get(dis), xDis, yc + 1, st.font, color, 'right');
}

/** A centred button ("ACTIVATE?") that holds the cursor when selected. */
export function button(ctx: Ctx2D, label: string, cx: number, yc: number, w: number, st: WinStyle, selected: boolean): void {
  cell(ctx, label, cx - w / 2, yc, w, st.rowH - 2, st.bold, G.cyan, selected, 'center');
}

/** Short type label of a target kind. */
export const KIND_LABEL: Record<string, string> = { airport: 'APT', vor: 'VOR', ndb: 'NDB', fix: 'INT', user: 'USR' };
