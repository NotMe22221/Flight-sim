/**
 * Drawing primitives shared by the steam gauges. Angles are "dial degrees": 0 at 12 o'clock,
 * positive clockwise. All functions assume the context is already translated so that the dial
 * centre is at the given (cx, cy) in design pixels.
 */
import type { Ctx2D } from '../canvas';
import { FONT_SANS } from '../canvas';
import { dialRad } from '../scales';
import { DEG } from '../../core/units';

export const GAUGE_COLORS = Object.freeze({
  face: '#0e0e10',
  bezel: '#2b2b2e',
  bezelHi: '#4a4a4f',
  bezelLo: '#151517',
  white: '#f2f2f2',
  grey: '#9a9a9a',
  green: '#35c24a',
  yellow: '#f2c230',
  red: '#e0262c',
  orange: '#f08a24',
  needle: '#f6f6f6',
  needleShadow: 'rgba(0,0,0,0.5)',
  text: '#e8e8e8',
  sky: '#2f7fd6',
  ground: '#7a4a1d',
  glass: 'rgba(255,255,255,0.05)',
});

const gaugeFonts = new Map<number, string>();
/** CSS font for a dial label; memoised per (rounded size, weight) so 30 Hz redraws build no strings. */
export const gaugeFont = (px: number, bold = false): string => {
  const size = Math.max(1, Math.round(px)), key = size * 2 + (bold ? 1 : 0);
  let f = gaugeFonts.get(key);
  if (f === undefined) {
    if (gaugeFonts.size > 512) gaugeFonts.clear();
    f = `${bold ? 'bold ' : ''}${size}px ${FONT_SANS}`;
    gaugeFonts.set(key, f);
  }
  return f;
};

/** Bezel ring + black face. `r` is the outer radius. */
export function drawBezel(ctx: Ctx2D, cx: number, cy: number, r: number): void {
  const ring = Math.max(2, r * 0.06);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = GAUGE_COLORS.bezelLo; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, r - ring * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = GAUGE_COLORS.bezel; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, r - ring, 0, Math.PI * 2);
  ctx.fillStyle = GAUGE_COLORS.face; ctx.fill();
  // subtle highlight on the upper-left of the bezel
  ctx.beginPath(); ctx.arc(cx, cy, r - ring * 0.5, Math.PI * 1.05, Math.PI * 1.65);
  ctx.strokeStyle = GAUGE_COLORS.bezelHi; ctx.lineWidth = ring * 0.3; ctx.stroke();
}

/** Inner radius of the face for an outer radius `r` (inside the bezel ring). */
export const faceRadius = (r: number): number => r - Math.max(2, r * 0.06);

/** Coloured arc band between two dial angles at radius `r` with the given stroke width. */
export function drawArcBand(ctx: Ctx2D, cx: number, cy: number, r: number, fromDeg: number, toDeg: number, width: number, color: string): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r, dialRad(fromDeg), dialRad(toDeg), false);
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'butt'; ctx.stroke();
}

/** Radial tick from radius `rOuter` inward by `length`. */
export function drawTick(ctx: Ctx2D, cx: number, cy: number, angleDeg: number, rOuter: number, length: number, width: number, color: string): void {
  const a = dialRad(angleDeg), c = Math.cos(a), s = Math.sin(a);
  ctx.beginPath();
  ctx.moveTo(cx + c * rOuter, cy + s * rOuter);
  ctx.lineTo(cx + c * (rOuter - length), cy + s * (rOuter - length));
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'butt'; ctx.stroke();
}

/** Upright label placed on the dial at an angle and radius. */
export function drawRadialLabel(ctx: Ctx2D, cx: number, cy: number, angleDeg: number, radius: number, text: string, font: string, color: string): void {
  const a = dialRad(angleDeg);
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
}

/** Centred text helper. */
export function drawText(ctx: Ctx2D, text: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'center', baseline: CanvasTextBaseline = 'middle'): void {
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = baseline;
  ctx.fillText(text, x, y);
}

/**
 * Pointer needle. The context must be translated to the hub; the needle is rotated to `angleDeg`
 * and points "up" (toward 12 o'clock before rotation).
 */
export function drawNeedle(ctx: Ctx2D, angleDeg: number, length: number, tail: number, width: number, color: string = GAUGE_COLORS.needle): void {
  ctx.save();
  ctx.rotate(angleDeg * DEG);
  ctx.beginPath();
  ctx.moveTo(0, -length);
  ctx.lineTo(width * 0.5, -length * 0.2);
  ctx.lineTo(width * 0.6, tail);
  ctx.lineTo(-width * 0.6, tail);
  ctx.lineTo(-width * 0.5, -length * 0.2);
  ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
  ctx.restore();
}

/** Needle hub cap. */
export function drawHub(ctx: Ctx2D, r: number, color: string = '#3a3a3e'): void {
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
  ctx.fillStyle = '#151517'; ctx.fill();
}

/** Small rectangular readout window with a dark background and thin border. Text is optional. */
export function drawWindow(ctx: Ctx2D, x: number, y: number, w: number, h: number, text?: string, font?: string, color: string = GAUGE_COLORS.white): void {
  ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#555'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  if (text !== undefined && font) drawText(ctx, text, x + w / 2, y + h / 2, font, color);
}

/** Red/orange warning flag with a label (GYRO, OFF…). Context translated to the gauge centre. */
export function drawFlag(ctx: Ctx2D, x: number, y: number, w: number, h: number, label: string, color: string = GAUGE_COLORS.red): void {
  ctx.fillStyle = color; ctx.fillRect(x, y, w, h);
  drawText(ctx, label, x + w / 2, y + h / 2, gaugeFont(h * 0.6, true), '#111');
}

/** A faint glass reflection over the face. */
export function drawGlass(ctx: Ctx2D, cx: number, cy: number, r: number): void {
  ctx.beginPath(); ctx.arc(cx - r * 0.25, cy - r * 0.3, r * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = GAUGE_COLORS.glass; ctx.fill();
}
