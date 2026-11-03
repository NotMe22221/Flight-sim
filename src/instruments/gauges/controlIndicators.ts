/**
 * Flap position indicator (0/10/20/30) and elevator trim indicator (nose down … TAKEOFF … nose up).
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import { FLAP_DETENTS } from '../c172';
import type { InstrumentReadings } from '../readings';
import { Gauge } from './Gauge';
import { GAUGE_COLORS, drawText, gaugeFont } from './common';

function frame(ctx: Ctx2D, w: number, h: number, title: string): void {
  ctx.fillStyle = GAUGE_COLORS.bezel; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = GAUGE_COLORS.face; ctx.fillRect(w * 0.06, h * 0.12, w * 0.88, h * 0.82);
  drawText(ctx, title, w / 2, h * 0.07, gaugeFont(h * 0.07, true), GAUGE_COLORS.text);
}

function pointer(ctx: Ctx2D, x: number, y: number, s: number, color: string): void {
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - s, y - s * 0.6); ctx.lineTo(x - s, y + s * 0.6); ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
}

export class FlapsIndicator extends Gauge {
  override readonly aspect = 1.3;
  constructor(private readonly detents: readonly number[] = FLAP_DETENTS, factory?: CanvasFactory) { super(factory); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    const h = size * this.aspect;
    frame(ctx, size, h, 'FLAPS');
    const max = this.detents[this.detents.length - 1] || 30;
    ctx.strokeStyle = GAUGE_COLORS.white; ctx.lineWidth = 1;
    for (const d of this.detents) {
      const y = h * 0.2 + (d / max) * h * 0.65;
      ctx.beginPath(); ctx.moveTo(size * 0.55, y); ctx.lineTo(size * 0.75, y); ctx.stroke();
      drawText(ctx, `${d}°`, size * 0.8, y, gaugeFont(h * 0.08), GAUGE_COLORS.white, 'left');
    }
    drawText(ctx, 'UP', size * 0.3, h * 0.2, gaugeFont(h * 0.065), GAUGE_COLORS.grey);
    drawText(ctx, 'FULL', size * 0.3, h * 0.85, gaugeFont(h * 0.065), GAUGE_COLORS.grey);
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const h = size * this.aspect;
    const max = this.detents[this.detents.length - 1] || 30;
    const y = -h / 2 + h * 0.2 + (Math.min(Math.max(r.flapsDeg, 0), max) / max) * h * 0.65;
    pointer(ctx, size * 0.05, y, size * 0.12, GAUGE_COLORS.white);
  }
}

export class TrimIndicator extends Gauge {
  override readonly aspect = 1.3;
  constructor(factory?: CanvasFactory) { super(factory); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    const h = size * this.aspect;
    frame(ctx, size, h, 'ELEV TRIM');
    const y0 = h * 0.2, y1 = h * 0.85, yc = (y0 + y1) / 2;
    // TAKEOFF band: 0 .. +5 % nose up
    ctx.fillStyle = GAUGE_COLORS.green;
    ctx.fillRect(size * 0.55, yc - (y1 - y0) * 0.05 * 0.5 - 2, size * 0.15, (y1 - y0) * 0.05 * 0.5 + 4);
    ctx.strokeStyle = GAUGE_COLORS.white; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(size * 0.62, y0); ctx.lineTo(size * 0.62, y1); ctx.stroke();
    for (let i = 0; i <= 10; i++) {
      const y = y0 + (i / 10) * (y1 - y0);
      ctx.beginPath(); ctx.moveTo(size * 0.55, y); ctx.lineTo(size * 0.7, y); ctx.stroke();
    }
    drawText(ctx, 'NOSE UP', size * 0.3, y0, gaugeFont(h * 0.06), GAUGE_COLORS.grey);
    drawText(ctx, 'NOSE DN', size * 0.3, y1, gaugeFont(h * 0.06), GAUGE_COLORS.grey);
    drawText(ctx, 'T/O', size * 0.85, yc, gaugeFont(h * 0.06), GAUGE_COLORS.green, 'center');
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const h = size * this.aspect;
    const y0 = h * 0.2, y1 = h * 0.85, yc = (y0 + y1) / 2;
    const y = -h / 2 + yc - r.trimNorm * (y1 - y0) * 0.5;
    pointer(ctx, size * 0.05, y, size * 0.12, GAUGE_COLORS.white);
  }
}
