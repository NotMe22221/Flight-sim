/**
 * Drawing primitives and layout for the external-view HUD: translucent pills, value readouts with
 * small units, vertical fill bars, and the viewport-dependent scale. All coordinates are CSS
 * pixels; `Hud` applies the device-pixel-ratio transform.
 */
import { clamp } from '../../core/math';
import type { Ctx2D } from '../canvas';
import { cond, condBold, fillTabular } from '../canvas';

/** HUD palette: translucent dark panels with MSFS-like white text and coloured states. */
export const HUD_COLORS = Object.freeze({
  panel: 'rgba(12,16,22,0.55)',
  panelStrong: 'rgba(12,16,22,0.72)',
  stroke: 'rgba(255,255,255,0.18)',
  text: '#ffffff',
  dim: 'rgba(255,255,255,0.62)',
  green: '#4ade80',
  cyan: '#22d3ee',
  amber: '#fbbf24',
  red: '#f43f5e',
  magenta: '#e879f9',
  barBg: 'rgba(255,255,255,0.16)',
});

/** Base width of the top strip (speed + heading tape + altitude blocks) at scale 1, CSS px. */
export const HUD_STRIP_BASE_W = 620;

/**
 * Scale factor for a viewport: follows the height (1 at 600 CSS px), limited so the top strip
 * still fits the width with 12 px margins (portrait phones), clamped to 0.45…1.6.
 */
export function hudScale(widthCss: number, heightCss: number, uiScale = 1): number {
  return clamp(Math.min(heightCss / 600, (widthCss - 24) / HUD_STRIP_BASE_W), 0.45, 1.6) * uiScale;
}

/** Rounded-rectangle path (manual arcs so it works on every 2D context). */
export function roundedRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y); ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr); ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h); ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr); ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Translucent panel with a hairline border. */
export function panel(ctx: Ctx2D, x: number, y: number, w: number, h: number, k: number, fill: string = HUD_COLORS.panel): void {
  roundedRectPath(ctx, x, y, w, h, 8 * k);
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = HUD_COLORS.stroke; ctx.lineWidth = 1; ctx.stroke();
}

/** Plain text. */
export function label(ctx: Ctx2D, s: string, x: number, y: number, px: number, color: string, align: CanvasTextAlign = 'left', bold = false): void {
  ctx.font = bold ? condBold.get(px) : cond.get(px);
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillText(s, x, y);
}

/** Tabular-digit value (no jitter while it changes). */
export function value(ctx: Ctx2D, s: string, x: number, y: number, px: number, color: string, align: 'left' | 'center' | 'right' = 'right'): void {
  ctx.font = condBold.get(px); ctx.fillStyle = color; ctx.textBaseline = 'middle';
  fillTabular(ctx, s, x, y, align);
}

/** Vertical fill bar 0..1 with an optional centre mark (for trim, `centred` fills from the middle). */
export function vbar(ctx: Ctx2D, x: number, y: number, w: number, h: number, frac: number, color: string, centred = false): void {
  ctx.fillStyle = HUD_COLORS.barBg; ctx.fillRect(x, y, w, h);
  const f = clamp(Number.isFinite(frac) ? frac : 0, centred ? -1 : 0, 1);
  ctx.fillStyle = color;
  if (centred) {
    const mid = y + h / 2, len = (f * h) / 2;
    ctx.fillRect(x, Math.min(mid, mid - len), w, Math.abs(len));
    ctx.fillStyle = HUD_COLORS.text; ctx.fillRect(x - 2, mid - 0.5, w + 4, 1);
  } else ctx.fillRect(x, y + h * (1 - f), w, h * f);
}
