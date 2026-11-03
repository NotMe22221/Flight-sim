/**
 * Radio stack for the steam panel: NAV/COM 1 & 2 (active/standby), transponder stub and a
 * KAP 140-style autopilot annunciator. Reads `SimSnapshot.nav1/nav2/autopilot` directly.
 */
import type { Ctx2D } from './canvas';
import { fillTabular, mono, monoBold, sans, sansBold } from './canvas';
import { formatAltitude, formatComFrequency, formatHeadingNum, formatNavFrequency, formatSquawk } from './format';
import { M_TO_FT } from '../core/units';
import type { AutopilotState, NavRadioState } from '../core/types';
import { GAUGE_COLORS } from './gauges/common';
import { LabelCache } from './labelCache';

// memoised labels: the steam panel redraws the stack at 30 Hz
const COM_LABEL = ['', 'COM1', 'COM2'];
const NAV_LABEL = ['', 'NAV1', 'NAV2'];
const comFreq = new LabelCache(formatComFrequency);
const navFreq = new LabelCache(formatNavFrequency, 10);
const squawkLabels = new LabelCache(formatSquawk);
const flLabels = new LabelCache((v) => `FL${Math.max(0, v)}`);
const altTargetLabels = new LabelCache((v) => formatAltitude(v, 100), 100);
const hdgBugLabels = new LabelCache((v) => `HDG ${formatHeadingNum(v)}`);

export interface ComState { activeKHz: number; standbyKHz: number }

const AMBER = '#ffb000';

function unit(ctx: Ctx2D, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = '#1a1a1d'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#060608'; ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
  ctx.strokeStyle = '#3a3a3e'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function label(ctx: Ctx2D, text: string, x: number, y: number, px: number, color: string = GAUGE_COLORS.grey, align: CanvasTextAlign = 'left'): void {
  ctx.font = sansBold.get(px); ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

/** One NAV/COM unit (two rows: COM above, NAV below). Height = 0.28 × width. */
export function drawNavCom(ctx: Ctx2D, x: number, y: number, w: number, nav: NavRadioState, com: ComState, index: 1 | 2): number {
  const h = w * 0.28;
  unit(ctx, x, y, w, h);
  const px = h * 0.3;
  ctx.textBaseline = 'middle';
  label(ctx, COM_LABEL[index], x + 10, y + h * 0.28, px * 0.55);
  ctx.font = monoBold.get(px); ctx.fillStyle = AMBER;
  fillTabular(ctx, comFreq.get(com.activeKHz), x + w * 0.5, y + h * 0.28, 'right');
  ctx.font = mono.get(px * 0.85); ctx.fillStyle = AMBER;
  fillTabular(ctx, comFreq.get(com.standbyKHz), x + w * 0.96, y + h * 0.28, 'right');
  label(ctx, NAV_LABEL[index], x + 10, y + h * 0.72, px * 0.55);
  ctx.font = monoBold.get(px); ctx.fillStyle = AMBER;
  fillTabular(ctx, navFreq.get(nav.activeKHz), x + w * 0.5, y + h * 0.72, 'right');
  ctx.font = mono.get(px * 0.85);
  fillTabular(ctx, navFreq.get(nav.standbyKHz), x + w * 0.96, y + h * 0.72, 'right');
  label(ctx, '↔', x + w * 0.56, y + h * 0.5, px * 0.6, '#777', 'center');
  if (nav.valid && nav.ident) label(ctx, nav.ident, x + w * 0.56, y + h * 0.88, px * 0.5, '#8ff08a', 'center');
  return h;
}

/** Transponder: code + mode + a small "ALT" readout. Height = 0.16 × width. */
export function drawTransponder(ctx: Ctx2D, x: number, y: number, w: number, code: number, mode: string, altFt: number): number {
  const h = w * 0.16;
  unit(ctx, x, y, w, h);
  const px = h * 0.5;
  label(ctx, 'XPDR', x + 10, y + h / 2, px * 0.55);
  ctx.font = monoBold.get(px); ctx.fillStyle = AMBER; ctx.textBaseline = 'middle';
  fillTabular(ctx, squawkLabels.get(code), x + w * 0.5, y + h / 2, 'right');
  label(ctx, mode, x + w * 0.58, y + h / 2, px * 0.6, AMBER);
  ctx.font = mono.get(px * 0.6); ctx.fillStyle = AMBER;
  fillTabular(ctx, flLabels.get(altFt / 100), x + w * 0.96, y + h / 2, 'right');
  return h;
}

/** KAP 140-style autopilot annunciator. Height = 0.2 × width. */
export function drawAutopilotUnit(ctx: Ctx2D, x: number, y: number, w: number, ap: AutopilotState): number {
  const h = w * 0.2;
  unit(ctx, x, y, w, h);
  const px = h * 0.34;
  const on = ap.engaged;
  label(ctx, on ? 'AP' : ap.flightDirector ? 'FD' : '', x + 10, y + h * 0.35, px, on ? AMBER : '#aaa');
  label(ctx, on || ap.flightDirector ? ap.lateral : '', x + w * 0.25, y + h * 0.35, px * 0.85, AMBER);
  label(ctx, ap.armedLateral ?? '', x + w * 0.25, y + h * 0.72, px * 0.6, '#aaa');
  label(ctx, on || ap.flightDirector ? ap.vertical : '', x + w * 0.5, y + h * 0.35, px * 0.85, AMBER);
  label(ctx, ap.armedVertical ?? '', x + w * 0.5, y + h * 0.72, px * 0.6, '#aaa');
  ctx.font = mono.get(px * 0.8); ctx.fillStyle = AMBER; ctx.textBaseline = 'middle';
  fillTabular(ctx, altTargetLabels.get(ap.altitudeTargetM * M_TO_FT), x + w * 0.96, y + h * 0.35, 'right');
  ctx.font = sans.get(px * 0.55); ctx.fillStyle = '#aaa'; ctx.textAlign = 'right';
  ctx.fillText(hdgBugLabels.get(ap.headingBugDeg), x + w * 0.96, y + h * 0.72);
  return h;
}
