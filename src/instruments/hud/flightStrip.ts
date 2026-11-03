/**
 * Top-centre HUD flight strip (docs/research/05 §6, MSFS-like): airspeed block, a ±30° heading
 * tape with the heading bug, altitude block with vertical speed and AGL, and below it the
 * autopilot mode line (AP/FD, lateral active + armed, vertical active + reference + armed).
 */
import { deltaDeg } from '../../core/math';
import type { AutopilotState } from '../../core/types';
import type { Ctx2D } from '../canvas';
import { formatHeadingNum, formatThousands, formatVerticalSpeed } from '../format';
import { verticalReference } from '../g1000/afcsBox';
import { LabelCache } from '../labelCache';
import { HUD_COLORS as C, label, panel, value } from './primitives';
import type { HudValues } from './values';

/** Pixel layout of the strip for a viewport, recomputed only on resize. */
export interface StripLayout {
  k: number; y: number; h: number;
  speedX: number; speedW: number;
  tapeX: number; tapeW: number;
  altX: number; altW: number;
  apY: number; apH: number;
}

export function createStripLayout(): StripLayout {
  return { k: 1, y: 0, h: 0, speedX: 0, speedW: 0, tapeX: 0, tapeW: 0, altX: 0, altW: 0, apY: 0, apH: 0 };
}

/** Lay the strip out centred at the top of a `widthCss` wide viewport with scale `k`. */
export function layoutStrip(widthCss: number, k: number, out: StripLayout): StripLayout {
  out.k = k; out.y = 12 * k; out.h = 64 * k;
  out.tapeW = 330 * k; out.speedW = 124 * k; out.altW = 150 * k;
  const gap = 8 * k, total = out.speedW + gap + out.tapeW + gap + out.altW;
  out.speedX = widthCss / 2 - total / 2;
  out.tapeX = out.speedX + out.speedW + gap;
  out.altX = out.tapeX + out.tapeW + gap;
  out.apY = out.y + out.h + 6 * k; out.apH = 26 * k;
  return out;
}

const ints = new LabelCache((v) => String(v));
const altLabels = new LabelCache((v) => formatThousands(v), 10);
const vsLabels = new LabelCache((v) => formatVerticalSpeed(v), 10);
const hdgLabels = new LabelCache((v) => formatHeadingNum(v) + '°');
const TAPE_HALF_DEG = 30;

/** Airspeed block: IAS large, GS small. */
export function drawSpeedBlock(ctx: Ctx2D, L: StripLayout, v: HudValues): void {
  const { k, y, h, speedX: x, speedW: w } = L;
  panel(ctx, x, y, w, h, k);
  label(ctx, 'IAS', x + 10 * k, y + 12 * k, 12 * k, C.dim);
  value(ctx, ints.get(v.iasKt), x + w - 34 * k, y + 29 * k, 24 * k, v.overspeed ? C.red : v.stall ? C.amber : C.text);
  label(ctx, 'KT', x + w - 10 * k, y + 32 * k, 12 * k, C.dim, 'right');
  label(ctx, 'GS', x + 10 * k, y + h - 10 * k, 11 * k, C.dim);
  value(ctx, ints.get(v.gsKt), x + w - 34 * k, y + h - 10 * k, 13 * k, C.text);
}

/**
 * Altitude alerter on the altitude block's label: black on cyan while approaching the selected
 * altitude, amber on a deviation after capture (flashing).
 */
export function drawAltAlert(ctx: Ctx2D, L: StripLayout, alert: 'none' | 'approach' | 'deviation', blinkOn: boolean): void {
  if (alert === 'none' || !blinkOn) return;
  const { k, y, altX: x } = L;
  ctx.fillStyle = alert === 'approach' ? C.cyan : C.amber;
  ctx.fillRect(x + 6 * k, y + 4 * k, 30 * k, 16 * k);
  label(ctx, 'ALT', x + 10 * k, y + 12 * k, 12 * k, '#111');
}

/** Altitude block: indicated altitude large, vertical speed and (low) AGL below. */
export function drawAltitudeBlock(ctx: Ctx2D, L: StripLayout, v: HudValues): void {
  const { k, y, h, altX: x, altW: w } = L;
  panel(ctx, x, y, w, h, k);
  label(ctx, 'ALT', x + 10 * k, y + 12 * k, 12 * k, C.dim);
  value(ctx, altLabels.get(v.altFt), x + w - 30 * k, y + 29 * k, 24 * k, C.text);
  label(ctx, 'FT', x + w - 10 * k, y + 32 * k, 12 * k, C.dim, 'right');
  const vs = v.vsFpm, up = vs > 50, down = vs < -50;
  const ay = y + h - 10 * k, ax = x + 14 * k;
  if (up || down) {
    ctx.fillStyle = C.text;
    ctx.beginPath();
    const d = up ? -1 : 1;
    ctx.moveTo(ax, ay + d * 6 * k); ctx.lineTo(ax - 5 * k, ay - d * 3 * k); ctx.lineTo(ax + 5 * k, ay - d * 3 * k); ctx.closePath(); ctx.fill();
  }
  value(ctx, vsLabels.get(vs), x + 62 * k, ay, 13 * k, C.text, 'right');
  const showAgl = v.aglFt < 2500 && !v.onGround;
  // the VS unit is dropped when the AGL readout needs the room (the box is too narrow for both)
  if (!showAgl) label(ctx, 'FPM', x + 65 * k, ay, 10 * k, C.dim);
  if (showAgl) {
    label(ctx, 'AGL', x + 98 * k, ay, 10 * k, C.dim, 'right');
    value(ctx, ints.get(Math.round(v.aglFt / 10) * 10), x + w - 10 * k, ay, 13 * k, v.aglFt < 200 ? C.amber : C.text);
  }
}

/** Heading tape ±30° with 5° ticks, labels every 10° (N/E/S/W letters), bug and readout. */
export function drawHeadingTape(ctx: Ctx2D, L: StripLayout, v: HudValues): void {
  const { k, y, h, tapeX: x, tapeW: w } = L;
  panel(ctx, x, y, w, h, k);
  const cx = x + w / 2, pxPerDeg = (w - 16 * k) / (2 * TAPE_HALF_DEG), tickY = y + 6 * k;
  ctx.save();
  ctx.beginPath(); ctx.rect(x + 6 * k, y, w - 12 * k, h); ctx.clip();
  ctx.strokeStyle = C.text; ctx.lineWidth = Math.max(1, 1.5 * k);
  const first = Math.ceil((v.hdgDeg - TAPE_HALF_DEG - 5) / 5) * 5;
  ctx.beginPath();
  for (let d = first; d <= v.hdgDeg + TAPE_HALF_DEG + 5; d += 5) {
    const px = cx + (d - v.hdgDeg) * pxPerDeg, major = d % 10 === 0;
    ctx.moveTo(px, tickY); ctx.lineTo(px, tickY + (major ? 9 : 5) * k);
  }
  ctx.stroke();
  for (let d = Math.ceil((v.hdgDeg - TAPE_HALF_DEG - 10) / 10) * 10; d <= v.hdgDeg + TAPE_HALF_DEG + 10; d += 10) {
    const px = cx + (d - v.hdgDeg) * pxPerDeg;
    label(ctx, tapeLabel(d), px, tickY + 18 * k, 12 * k, C.text, 'center', true);
  }
  // heading bug (cyan), pinned to the tape edge when out of view
  const bugPx = cx + Math.max(-TAPE_HALF_DEG, Math.min(TAPE_HALF_DEG, deltaDeg(v.bugDeg, v.hdgDeg))) * pxPerDeg;
  ctx.fillStyle = C.cyan;
  ctx.beginPath(); ctx.moveTo(bugPx, y + 4 * k); ctx.lineTo(bugPx - 6 * k, y); ctx.lineTo(bugPx + 6 * k, y); ctx.closePath(); ctx.fill();
  ctx.fillRect(bugPx - 6 * k, y, 12 * k, 2 * k);
  ctx.restore();
  // lubber line and digital heading
  ctx.fillStyle = C.amber; ctx.fillRect(cx - 1 * k, y + 2 * k, 2 * k, 16 * k);
  value(ctx, hdgLabels.get(v.hdgDeg), cx, y + h - 15 * k, 20 * k, C.text, 'center');
}

/** Cardinal letter or tens of degrees for a tape label at heading `d` (any integer, wrapped). */
export function tapeLabel(d: number): string {
  const w = ((Math.round(d) % 360) + 360) % 360;
  if (w === 0) return 'N';
  if (w === 90) return 'E';
  if (w === 180) return 'S';
  if (w === 270) return 'W';
  return TENS[w / 10] ?? '';
}
const TENS: string[] = [];
for (let i = 0; i < 36; i++) TENS.push(String(i));

/** Autopilot mode line under the strip; hidden while both AP and FD are off. */
/**
 * Autopilot mode line (GFC 700 order: AP/FD, YD, lateral, armed lateral, vertical, reference, armed vertical).
 * `flash` = 1 red / 2 amber flashes 'AP' after a disconnect (autopilot let go / pilot disconnected);
 * LVL recovery shows 'LVL' in both mode fields.
 */
export function drawApModes(ctx: Ctx2D, L: StripLayout, ap: AutopilotState, flash: 0 | 1 | 2 = 0, blinkOn = true): void {
  if (!ap.engaged && !ap.flightDirector && !flash) return;
  const { k, apY: y, apH: h } = L;
  const w = L.tapeW, x = L.tapeX, cy = y + h / 2;
  panel(ctx, x, y, w, h, k, C.panelStrong);
  const lvl = ap.lvl === true;
  if (ap.engaged) label(ctx, 'AP', x + 10 * k, cy, 14 * k, C.green, 'left', true);
  else if (flash) { if (blinkOn) label(ctx, 'AP', x + 10 * k, cy, 14 * k, flash === 1 ? C.red : C.amber, 'left', true); }
  else label(ctx, 'FD', x + 10 * k, cy, 14 * k, C.text, 'left', true);
  if (!ap.engaged && !ap.flightDirector) return; // only the disconnect flash
  if (ap.yawDamper) label(ctx, 'YD', x + 36 * k, cy, 12 * k, C.green, 'left', true);
  if (lvl) {
    label(ctx, 'LVL', x + 64 * k, cy, 14 * k, C.green, 'left', true);
    label(ctx, 'LVL', x + 160 * k, cy, 14 * k, C.green, 'left', true);
    return;
  }
  if (ap.lateral !== 'OFF') label(ctx, ap.lateral, x + 64 * k, cy, 14 * k, C.green, 'left', true);
  if (ap.armedLateral && ap.armedLateral !== 'OFF') label(ctx, ap.armedLateral, x + 108 * k, cy, 12 * k, C.text);
  if (ap.vertical !== 'OFF') label(ctx, ap.vertical, x + 160 * k, cy, 14 * k, C.green, 'left', true);
  const ref = verticalReference(ap);
  if (ref) value(ctx, ref, x + 204 * k, cy, 13 * k, C.green, 'left');
  if (ap.armedVertical && ap.armedVertical !== 'OFF') label(ctx, ap.armedVertical, x + w - 10 * k, cy, 12 * k, C.text, 'right');
}
