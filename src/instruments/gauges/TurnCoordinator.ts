/**
 * Electric turn coordinator (2-minute marks) with inclinometer ball. The miniature aircraft banks
 * 20° per standard rate; the ball rides a curved tube at the bottom.
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import { DEG } from '../../core/units';
import type { InstrumentReadings } from '../readings';
import { Gauge } from './Gauge';
import { GAUGE_COLORS, drawBezel, drawFlag, drawGlass, drawText, drawTick, faceRadius, gaugeFont } from './common';

const STD_RATE_DEG = 20;

export class TurnCoordinator extends Gauge {
  constructor(factory?: CanvasFactory) { super(factory); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    const cx = size / 2, cy = size / 2, R = size / 2;
    drawBezel(ctx, cx, cy, R);
    const fr = faceRadius(R);
    for (const a of [270, 90, 270 - STD_RATE_DEG, 90 + STD_RATE_DEG]) drawTick(ctx, cx, cy, a, fr * 0.95, fr * 0.14, Math.max(2, fr * 0.04), GAUGE_COLORS.white);
    drawText(ctx, 'L', cx - fr * 0.68, cy + fr * 0.38, gaugeFont(fr * 0.13, true), GAUGE_COLORS.white);
    drawText(ctx, 'R', cx + fr * 0.68, cy + fr * 0.38, gaugeFont(fr * 0.13, true), GAUGE_COLORS.white);
    drawText(ctx, 'TURN COORDINATOR', cx, cy - fr * 0.4, gaugeFont(fr * 0.09, true), GAUGE_COLORS.text);
    drawText(ctx, 'D.C. ELEC', cx, cy - fr * 0.62, gaugeFont(fr * 0.07), GAUGE_COLORS.grey);
    drawText(ctx, '2 MIN', cx, cy + fr * 0.3, gaugeFont(fr * 0.09), GAUGE_COLORS.grey);
    drawText(ctx, 'NO PITCH INFORMATION', cx, cy + fr * 0.88, gaugeFont(fr * 0.065), GAUGE_COLORS.grey);
    // inclinometer tube
    const ty = cy + fr * 0.62, tw = fr * 0.6, th = fr * 0.16;
    ctx.fillStyle = '#1b1b1e'; ctx.fillRect(cx - tw / 2, ty - th / 2, tw, th);
    ctx.strokeStyle = '#666'; ctx.lineWidth = 1; ctx.strokeRect(cx - tw / 2 + 0.5, ty - th / 2 + 0.5, tw - 1, th - 1);
    const ballD = th * 0.8;
    ctx.strokeStyle = GAUGE_COLORS.white; ctx.lineWidth = Math.max(1.5, fr * 0.02);
    ctx.beginPath();
    ctx.moveTo(cx - ballD / 2, ty - th / 2); ctx.lineTo(cx - ballD / 2, ty + th / 2);
    ctx.moveTo(cx + ballD / 2, ty - th / 2); ctx.lineTo(cx + ballD / 2, ty + th / 2);
    ctx.stroke();
    drawGlass(ctx, cx, cy, fr);
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const fr = faceRadius(size / 2);
    // miniature aircraft
    ctx.save();
    ctx.rotate(r.turn.rateStd * STD_RATE_DEG * DEG);
    ctx.strokeStyle = GAUGE_COLORS.white; ctx.lineWidth = Math.max(2.5, fr * 0.06); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-fr * 0.62, 0); ctx.lineTo(fr * 0.62, 0); ctx.stroke();
    ctx.lineWidth = Math.max(2, fr * 0.045);
    ctx.beginPath(); ctx.moveTo(0, -fr * 0.14); ctx.lineTo(0, fr * 0.02); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-fr * 0.14, fr * 0.12); ctx.lineTo(fr * 0.14, fr * 0.12); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, fr * 0.08, 0, Math.PI * 2); ctx.fillStyle = GAUGE_COLORS.white; ctx.fill();
    ctx.restore();
    // ball: rides an arc whose centre is above the tube
    const ty = fr * 0.62, th = fr * 0.16, ballD = th * 0.8, arcR = fr * 1.6;
    const ang = (r.turn.ballWidths * ballD) / arcR;
    const bx = Math.sin(ang) * arcR, by = ty - arcR + Math.cos(ang) * arcR;
    ctx.beginPath(); ctx.arc(bx, by, ballD / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#111'; ctx.fill();
    ctx.beginPath(); ctx.arc(bx - ballD * 0.15, by - ballD * 0.15, ballD * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill();
    if (!r.turn.valid) drawFlag(ctx, fr * 0.3, -fr * 0.3, fr * 0.35, fr * 0.14, 'OFF');
  }
}
