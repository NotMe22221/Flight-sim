/**
 * Small PFD data windows around the HSI and along the bottom (docs/research/05 §2.2): ground
 * speed (under TAS), wind (option 1: arrow + speed, option 2: head/cross components), OAT, the
 * transponder, UTC clock and elapsed timer, the DME window and the BRG1/BRG2 info windows.
 */
import { DEG } from '../../core/units';
import type { Ctx2D } from '../canvas';
import { formatDistanceNm, formatNavFrequency, formatSquawk, formatTimer, formatUtc } from '../format';
import { LabelCache } from '../labelCache';
import type { InstrumentReadings } from '../readings';
import { type BearingState, dmeDistanceNm } from './navData';
import { G, cond, condBold } from './palette';
import { box, num, text } from './widgets';
import type { NavRadioState } from '../../core/types';

interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
const rect = (x: number, y: number, w: number, h: number): Rect => Object.freeze({ x, y, w, h });

/** Info-window layout in PFD design units. */
export const INFO = Object.freeze({
  gs: rect(60, 588, 90, 24),
  wind: rect(160, 604, 120, 64),
  oat: rect(4, 708, 146, 26),
  dme: rect(262, 466, 104, 62),
  brg1: rect(262, 676, 120, 58),
  brg2: rect(642, 676, 120, 58),
  xpdr: rect(770, 708, 120, 26),
  clock: rect(894, 708, 126, 26),
  timer: rect(894, 680, 126, 26),
  marker: rect(800, 114, 30, 28),
});

/** Wind display option: 1 = arrow + speed, 2 = headwind/crosswind components. */
export type WindOption = 1 | 2;
/** Below this TAS (or on the ground) the wind box reads NO WIND DATA, kt. */
export const WIND_MIN_TAS_KT = 30;

const ktLabels = new LabelCache((v) => `${v}KT`);
const intLabels = new LabelCache((v) => String(v));
const oatLabels = new LabelCache((v) => `${v}°C`);
const utcLabels = new LabelCache(formatUtc, 1000);
const timerLabels = new LabelCache(formatTimer);
const distLabels = new LabelCache((v) => (Number.isFinite(v) ? formatDistanceNm(v) + 'NM' : '-.--NM'), 0.1);
const navFreq = new LabelCache(formatNavFrequency, 10);
const squawkLabels = new LabelCache(formatSquawk);

/**
 * Arrow of length `len` centred on (x, y) pointing toward `angleRad` (clockwise from screen up).
 */
export function drawArrow(ctx: Ctx2D, x: number, y: number, len: number, angleRad: number, color: string): void {
  const s = Math.sin(angleRad), c = -Math.cos(angleRad); // unit vector toward the head (screen y down)
  const hx = x + s * len / 2, hy = y + c * len / 2;
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x - s * len / 2, y - c * len / 2); ctx.lineTo(hx - s * 8, hy - c * 8); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx - s * 11 - c * 6, hy - c * 11 + s * 6);
  ctx.lineTo(hx - s * 11 + c * 6, hy - c * 11 - s * 6);
  ctx.closePath(); ctx.fill();
}

/** Ground-speed box under the TAS box. */
export function drawGroundSpeed(ctx: Ctx2D, r: InstrumentReadings): void {
  const b = INFO.gs;
  box(ctx, b.x, b.y, b.w, b.h);
  text(ctx, 'GS', b.x + 4, b.y + b.h / 2, cond.get(14), G.white);
  num(ctx, ktLabels.get(r.gsKt), b.x + b.w - 4, b.y + b.h / 2, condBold.get(16), G.white, 'right');
}

/** Wind box left of the HSI. */
export function drawWind(ctx: Ctx2D, r: InstrumentReadings, option: WindOption): void {
  const b = INFO.wind, w = r.wind;
  box(ctx, b.x, b.y, b.w, b.h);
  if (r.onGround || r.tasKt < WIND_MIN_TAS_KT) {
    text(ctx, 'NO WIND', b.x + b.w / 2, b.y + b.h / 2 - 9, condBold.get(15), G.white, 'center');
    text(ctx, 'DATA', b.x + b.w / 2, b.y + b.h / 2 + 10, condBold.get(15), G.white, 'center');
    return;
  }
  if (option === 1) {
    // arrow shows where the air moves, relative to the nose
    const rel = (w.fromMagDeg + 180 - r.heading.magDeg) * DEG;
    if (w.speedKt >= 1) drawArrow(ctx, b.x + 32, b.y + b.h / 2, 40, rel, G.white);
    num(ctx, ktLabels.get(w.speedKt), b.x + b.w - 8, b.y + b.h / 2, condBold.get(18), G.white, 'right');
    return;
  }
  const head = w.headwindKt, cross = w.crosswindKt;
  const cy1 = b.y + b.h * 0.3, cy2 = b.y + b.h * 0.72;
  // headwind pushes toward the tail (arrow down), tailwind up; wind from the right pushes left
  drawArrow(ctx, b.x + 22, cy1, 18, head >= 0 ? Math.PI : 0, G.white);
  num(ctx, intLabels.get(Math.abs(head)), b.x + 44, cy1, condBold.get(18), G.white, 'left');
  drawArrow(ctx, b.x + 22, cy2, 18, cross >= 0 ? -Math.PI / 2 : Math.PI / 2, G.white);
  num(ctx, intLabels.get(Math.abs(cross)), b.x + 44, cy2, condBold.get(18), G.white, 'left');
}

/** OAT box at the bottom left. */
export function drawOat(ctx: Ctx2D, r: InstrumentReadings): void {
  const b = INFO.oat;
  box(ctx, b.x, b.y, b.w, b.h, G.barBg);
  text(ctx, 'OAT', b.x + 8, b.y + b.h / 2, cond.get(15), G.white);
  num(ctx, oatLabels.get(r.oatC), b.x + b.w - 10, b.y + b.h / 2, condBold.get(17), G.white, 'right');
}

/** Transponder box: code green in ALT/ON, white in STBY. */
export function drawTransponderBox(ctx: Ctx2D, code: number, mode: string): void {
  const b = INFO.xpdr, live = mode === 'ALT' || mode === 'ON';
  box(ctx, b.x, b.y, b.w, b.h, G.barBg);
  text(ctx, 'XPDR', b.x + 5, b.y + b.h / 2, cond.get(13), G.white);
  num(ctx, squawkLabels.get(code), b.x + 84, b.y + b.h / 2, condBold.get(17), live ? G.green : G.white, 'right');
  text(ctx, mode, b.x + b.w - 6, b.y + b.h / 2, condBold.get(14), live ? G.green : G.white, 'right');
}

/** UTC clock (bottom right) and, while it runs or holds a value, the elapsed timer above it. */
export function drawClock(ctx: Ctx2D, r: InstrumentReadings): void {
  const b = INFO.clock;
  box(ctx, b.x, b.y, b.w, b.h, G.barBg);
  text(ctx, 'UTC', b.x + 6, b.y + b.h / 2, cond.get(14), G.white);
  num(ctx, utcLabels.get(r.clock.utcMs), b.x + b.w - 6, b.y + b.h / 2, condBold.get(17), G.white, 'right');
  if (r.clock.timerS >= 1) {
    const t = INFO.timer;
    box(ctx, t.x, t.y, t.w, t.h);
    text(ctx, 'TMR', t.x + 6, t.y + t.h / 2, cond.get(14), G.white);
    num(ctx, timerLabels.get(r.clock.timerS), t.x + t.w - 6, t.y + t.h / 2, condBold.get(17), G.white, 'right');
  }
}

/** DME window (upper left of the HSI): source, frequency and distance. */
export function drawDmeWindow(ctx: Ctx2D, label: string, nav: NavRadioState): void {
  const b = INFO.dme;
  box(ctx, b.x, b.y, b.w, b.h);
  text(ctx, 'DME', b.x + 6, b.y + 11, condBold.get(14), G.white);
  text(ctx, label, b.x + b.w - 6, b.y + 11, cond.get(14), G.green, 'right');
  num(ctx, navFreq.get(nav.activeKHz), b.x + b.w - 6, b.y + 30, condBold.get(16), G.green, 'right');
  num(ctx, distLabels.get(dmeDistanceNm(nav)), b.x + b.w - 6, b.y + 50, condBold.get(16), G.white, 'right');
}

/** Marker-beacon annunciator left of the altitude tape: O cyan, M amber, I white. */
export function drawMarkerBeacon(ctx: Ctx2D, marker: NavRadioState['marker']): void {
  if (!marker) return;
  const b = INFO.marker;
  const letter = marker === 'outer' ? 'O' : marker === 'middle' ? 'M' : 'I';
  const color = marker === 'outer' ? G.cyan : marker === 'middle' ? G.amber : G.white;
  box(ctx, b.x, b.y, b.w, b.h, color);
  text(ctx, letter, b.x + b.w / 2, b.y + b.h / 2 + 1, condBold.get(20), G.black, 'center');
}

/**
 * BRG1/BRG2 info window: distance, ident and source with the pointer's symbol (single line for
 * BRG1, double for BRG2). Hidden when the source is OFF.
 */
export function drawBearingInfo(ctx: Ctx2D, which: 1 | 2, b: BearingState): void {
  if (b.source === 'OFF') return;
  const rc = which === 1 ? INFO.brg1 : INFO.brg2;
  const right = which === 2, ax = right ? rc.x + rc.w - 8 : rc.x + 8, align = right ? 'right' : 'left';
  box(ctx, rc.x, rc.y, rc.w, rc.h);
  num(ctx, distLabels.get(b.valid ? b.distanceNm : Number.NaN), ax, rc.y + 11, condBold.get(16), G.white, align);
  text(ctx, b.valid && b.ident ? b.ident : '----', ax, rc.y + 29, condBold.get(16), G.cyan, align);
  text(ctx, b.label, ax, rc.y + 47, cond.get(14), G.white, align);
  // pointer symbol next to the source label
  const sx = right ? rc.x + 14 : rc.x + rc.w - 14, sy = rc.y + 47;
  ctx.strokeStyle = G.cyan; ctx.lineWidth = 2;
  ctx.beginPath();
  if (which === 1) { ctx.moveTo(sx - 9, sy); ctx.lineTo(sx + 9, sy); }
  else { ctx.moveTo(sx - 9, sy - 3); ctx.lineTo(sx + 9, sy - 3); ctx.moveTo(sx - 9, sy + 3); ctx.lineTo(sx + 9, sy + 3); }
  ctx.stroke();
}
