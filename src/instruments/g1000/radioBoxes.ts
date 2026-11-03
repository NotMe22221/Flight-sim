/**
 * NAV and COM frequency boxes in the top bar (docs/research/05 §2.2). As on the G1000, active
 * frequencies sit toward the centre and standby frequencies toward the outer edges, where the
 * cyan tuning box frames the standby of the radio the knobs currently tune (NAV1 / COM1). The
 * active NAV frequency turns green when that receiver is the CDI source and shows the decoded
 * station ident; the active COM1 frequency is green (selected for transmit).
 */
import type { NavRadioState } from '../../core/types';
import type { Ctx2D } from '../canvas';
import { formatComFrequency, formatNavFrequency } from '../format';
import { LabelCache } from '../labelCache';
import type { ComState } from '../radioStack';
import { G, PFD, cond, condBold } from './palette';
import type { CdiSource } from './palette';
import { box, num, text } from './widgets';

/** Frequency-box layout in design units (shared by PFD and MFD top bars). */
export const RADIO = Object.freeze({
  navX: 0, navW: 300, comX: 724, comW: 300, h: PFD.topBarH,
  row1: 11, row2: 31,
});

const navFreq = new LabelCache(formatNavFrequency, 10);
const comFreq = new LabelCache(formatComFrequency, 1);

function tuningBox(ctx: Ctx2D, x: number, y: number, w: number): void {
  ctx.strokeStyle = G.cyan; ctx.lineWidth = 1.5;
  ctx.strokeRect(x + 0.5, y - 9.5, w, 19);
}

/** One NAV row: label, standby, transfer arrow, active (green when CDI source), ident. */
export function drawNavRow(ctx: Ctx2D, y: number, label: string, nav: NavRadioState, isCdiSource: boolean, focused: boolean): void {
  const x = RADIO.navX, f = condBold.get(18);
  text(ctx, label, x + 6, y, cond.get(14), G.white, 'left');
  if (focused) tuningBox(ctx, x + 58, y, 64);
  num(ctx, navFreq.get(nav.standbyKHz), x + 118, y, f, G.white, 'right');
  text(ctx, '↔', x + 136, y, cond.get(15), G.white, 'center');
  num(ctx, navFreq.get(nav.activeKHz), x + 210, y, f, isCdiSource ? G.green : G.white, 'right');
  if (nav.valid && nav.ident) text(ctx, nav.ident, x + 220, y, condBold.get(16), isCdiSource ? G.green : G.white, 'left');
}

/** One COM row: active (green when selected), transfer arrow, standby, label at the right edge. */
export function drawComRow(ctx: Ctx2D, y: number, label: string, com: ComState, selected: boolean, focused: boolean): void {
  const x = RADIO.comX, f = condBold.get(18);
  num(ctx, comFreq.get(com.activeKHz), x + 104, y, f, selected ? G.green : G.white, 'right');
  text(ctx, '↔', x + 124, y, cond.get(15), G.white, 'center');
  if (focused) tuningBox(ctx, x + 140, y, 74);
  num(ctx, comFreq.get(com.standbyKHz), x + 210, y, f, G.white, 'right');
  text(ctx, label, x + RADIO.comW - 6, y, cond.get(14), G.white, 'right');
}

/** NAV1/NAV2 box at the top left; the cyan tuning box frames the standby the NAV knob tunes. */
export function drawNavBox(ctx: Ctx2D, nav1: NavRadioState, nav2: NavRadioState, cdiSource: CdiSource, focus: 1 | 2 = 1): void {
  box(ctx, RADIO.navX, 0, RADIO.navW, RADIO.h, G.barBg);
  drawNavRow(ctx, RADIO.row1, 'NAV1', nav1, cdiSource === 'NAV1', focus === 1);
  drawNavRow(ctx, RADIO.row2, 'NAV2', nav2, cdiSource === 'NAV2', focus === 2);
}

/** COM1/COM2 box at the top right (COM1 transmits; the tuning box follows the COM knob's 1-2 push). */
export function drawComBox(ctx: Ctx2D, com1: ComState, com2: ComState, focus: 1 | 2 = 1): void {
  box(ctx, RADIO.comX, 0, RADIO.comW, RADIO.h, G.barBg);
  drawComRow(ctx, RADIO.row1, 'COM1', com1, true, focus === 1);
  drawComRow(ctx, RADIO.row2, 'COM2', com2, false, focus === 2);
}
