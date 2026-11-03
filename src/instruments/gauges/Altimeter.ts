/**
 * Three-pointer sensitive altimeter with Kollsman windows (inHg right, hPa left) and the striped
 * low-altitude warning sector below 10 000 ft.
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import { formatBaroHpa, formatBaroInHg } from '../format';
import type { InstrumentReadings } from '../readings';
import { Gauge } from './Gauge';
import { GAUGE_COLORS, drawBezel, drawGlass, drawHub, drawNeedle, drawRadialLabel, drawText, drawTick, drawWindow, faceRadius, gaugeFont } from './common';

export class Altimeter extends Gauge {
  constructor(factory?: CanvasFactory) { super(factory); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    const cx = size / 2, cy = size / 2, R = size / 2;
    drawBezel(ctx, cx, cy, R);
    const fr = faceRadius(R);
    for (let i = 0; i < 50; i++) {
      const major = i % 5 === 0;
      drawTick(ctx, cx, cy, i * 7.2, fr * 0.92, major ? fr * 0.14 : fr * 0.07, major ? 2 : 1, GAUGE_COLORS.white);
    }
    const font = gaugeFont(fr * 0.19, true);
    for (let i = 0; i < 10; i++) drawRadialLabel(ctx, cx, cy, i * 36, fr * 0.66, String(i), font, GAUGE_COLORS.white);
    drawText(ctx, 'ALT', cx, cy - fr * 0.36, gaugeFont(fr * 0.13, true), GAUGE_COLORS.text);
    drawText(ctx, 'FEET', cx, cy + fr * 0.4, gaugeFont(fr * 0.09), GAUGE_COLORS.grey);
    // Kollsman window frames: inHg at 3 o'clock, hPa at 9 o'clock
    drawWindow(ctx, cx + fr * 0.3, cy - fr * 0.09, fr * 0.42, fr * 0.18);
    drawWindow(ctx, cx - fr * 0.72, cy - fr * 0.09, fr * 0.42, fr * 0.18);
    drawText(ctx, 'IN HG', cx + fr * 0.51, cy + fr * 0.17, gaugeFont(fr * 0.07), GAUGE_COLORS.grey);
    drawText(ctx, 'HPA', cx - fr * 0.51, cy + fr * 0.17, gaugeFont(fr * 0.07), GAUGE_COLORS.grey);
    drawGlass(ctx, cx, cy, fr);
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const fr = faceRadius(size / 2);
    const a = r.altimeter;
    const font = gaugeFont(fr * 0.12);
    drawText(ctx, formatBaroInHg(a.settingInHg), fr * 0.51, 0, font, GAUGE_COLORS.white);
    drawText(ctx, formatBaroHpa(a.settingHPa), -fr * 0.51, 0, font, GAUGE_COLORS.white);
    const alt = a.indicatedFt;
    if (alt < 10000) {
      // striped low-altitude sector between the 1 and 2 (visible until 10 000 ft)
      ctx.save();
      ctx.rotate((54 - 90) * (Math.PI / 180));
      ctx.fillStyle = GAUGE_COLORS.white; ctx.fillRect(fr * 0.4, -fr * 0.06, fr * 0.25, fr * 0.12);
      ctx.fillStyle = '#000';
      for (let i = 0; i < 4; i++) ctx.fillRect(fr * (0.42 + i * 0.06), -fr * 0.06, fr * 0.025, fr * 0.12);
      ctx.restore();
    }
    const hundreds = ((alt % 1000) + 1000) % 1000;
    const thousands = ((alt % 10000) + 10000) % 10000;
    // 10 000-ft pointer: thin stem with a small outer triangle
    const tenK = (alt / 100000) * 360;
    ctx.save();
    ctx.rotate(tenK * (Math.PI / 180));
    ctx.strokeStyle = GAUGE_COLORS.needle; ctx.lineWidth = Math.max(1, fr * 0.02);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -fr * 0.82); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -fr * 0.92); ctx.lineTo(-fr * 0.05, -fr * 0.8); ctx.lineTo(fr * 0.05, -fr * 0.8); ctx.closePath();
    ctx.fillStyle = GAUGE_COLORS.needle; ctx.fill();
    ctx.restore();
    drawNeedle(ctx, (thousands / 10000) * 360, fr * 0.55, fr * 0.1, Math.max(4, fr * 0.12));
    drawNeedle(ctx, (hundreds / 1000) * 360, fr * 0.86, fr * 0.16, Math.max(3, fr * 0.06));
    drawHub(ctx, Math.max(4, fr * 0.08));
  }
}
