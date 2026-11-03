/**
 * Small drawing widgets shared by the PFD/MFD: translucent boxes, labelled text, rolling-drum
 * numeric windows, pointers and the red-X failure overlay. All design-space coordinates.
 */
import type { Ctx2D } from '../canvas';
import { fillTabular } from '../canvas';
import { G, condBold } from './palette';

export function box(ctx: Ctx2D, x: number, y: number, w: number, h: number, fill: string = G.boxBg, stroke?: string): void {
  ctx.fillStyle = fill; ctx.fillRect(x, y, w, h);
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); }
}

export function text(ctx: Ctx2D, s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'left', baseline: CanvasTextBaseline = 'middle'): void {
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = baseline;
  ctx.fillText(s, x, y);
}

/** Tabular-digit text (fixed advances) for values that change every frame. */
export function num(ctx: Ctx2D, s: string, x: number, y: number, font: string, color: string, align: 'left' | 'center' | 'right' = 'left'): void {
  ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'middle';
  fillTabular(ctx, s, x, y, align);
}

export const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
export const TWENTIES = ['00', '20', '40', '60', '80'];

/**
 * Rolling drum: draws `labels[i mod n]` stacked vertically with line height `lineH`, scrolled so
 * that fractional `position` sits at (x, yCentre). Like the tapes it sits in, larger values are
 * above: as `position` grows the digits roll down and the next one enters from the top. The caller
 * clips to the window.
 */
export function drum(ctx: Ctx2D, x: number, yCentre: number, lineH: number, position: number, labels: readonly string[], font: string, color: string, align: 'left' | 'center' | 'right' = 'center'): void {
  const n = labels.length;
  const base = Math.floor(position), frac = position - base;
  ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'middle';
  for (let k = -1; k <= 2; k++) {
    const idx = (((base + k) % n) + n) % n;
    const y = yCentre - (k - frac) * lineH;
    fillTabular(ctx, labels[idx], x, y, align);
  }
}

/** Left- or right-pointing window pointer polygon. */
export function pointerWindow(ctx: Ctx2D, x: number, y: number, w: number, h: number, tip: 'left' | 'right', fill: string = G.black, stroke: string = G.white): void {
  const t = h * 0.35;
  ctx.beginPath();
  if (tip === 'left') {
    ctx.moveTo(x, y + h / 2); ctx.lineTo(x + t, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x + t, y + h);
  } else {
    ctx.moveTo(x + w, y + h / 2); ctx.lineTo(x + w - t, y); ctx.lineTo(x, y); ctx.lineTo(x, y + h); ctx.lineTo(x + w - t, y + h);
  }
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke();
}

/** Red X over a failed display area. */
export function redX(ctx: Ctx2D, x: number, y: number, w: number, h: number): void {
  ctx.strokeStyle = G.red; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.moveTo(x + w, y); ctx.lineTo(x, y + h); ctx.stroke();
}

/** Small cyan bug (notch) used for heading / altitude / airspeed targets, pointing left or right. */
export function bug(ctx: Ctx2D, x: number, y: number, size: number, side: 'left' | 'right', color: string = G.cyan): void {
  const d = side === 'left' ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(x, y - size); ctx.lineTo(x + d * size * 0.6, y - size); ctx.lineTo(x + d * size * 0.6, y - size * 0.3); ctx.lineTo(x, y);
  ctx.lineTo(x + d * size * 0.6, y + size * 0.3); ctx.lineTo(x + d * size * 0.6, y + size); ctx.lineTo(x, y + size);
  ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
}

/** Softkey bar with 12 labels (empty strings leave a blank key). */
export function softkeys(ctx: Ctx2D, y: number, h: number, width: number, labels: readonly string[], highlighted = -1): void {
  const n = labels.length, w = width / n;
  ctx.fillStyle = G.bezel; ctx.fillRect(0, y, width, h);
  for (let i = 0; i < n; i++) {
    const x = i * w + 2;
    ctx.fillStyle = i === highlighted ? '#3a3a3a' : G.softkeyBg; ctx.fillRect(x, y + 2, w - 4, h - 4);
    if (labels[i]) text(ctx, labels[i], x + (w - 4) / 2, y + h / 2, condBold.get(14), i === highlighted ? G.cyan : G.white, 'center');
  }
}
