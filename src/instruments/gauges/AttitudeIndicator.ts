/**
 * Vacuum attitude indicator: moving sky/ground card with pitch ladder, bank scale on the card and
 * a fixed pointer, miniature aircraft symbol, GYRO flag when the rotor is slow. Readings come from
 * `InstrumentModel` (spin-up, erection error, precession already applied).
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import { DEG } from '../../core/units';
import type { InstrumentReadings } from '../readings';
import { Gauge } from './Gauge';
import { GAUGE_COLORS, drawBezel, drawFlag, drawGlass, drawText, faceRadius, gaugeFont } from './common';

const BANK_TICKS = [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60];

export class AttitudeIndicator extends Gauge {
  constructor(factory?: CanvasFactory) { super(factory); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    const cx = size / 2, cy = size / 2, R = size / 2;
    drawBezel(ctx, cx, cy, R);
    const fr = faceRadius(R);
    // fixed bank pointer (triangle pointing down at the card rim)
    ctx.beginPath();
    ctx.moveTo(cx, cy - fr * 0.86);
    ctx.lineTo(cx - fr * 0.05, cy - fr * 0.98);
    ctx.lineTo(cx + fr * 0.05, cy - fr * 0.98);
    ctx.closePath();
    ctx.fillStyle = GAUGE_COLORS.white; ctx.fill();
    drawGlass(ctx, cx, cy, fr);
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const fr = faceRadius(size / 2);
    const Rh = fr * 0.86;
    const pxPerDeg = Rh / 32;
    const roll = r.attitude.rollDeg * DEG, pitch = r.attitude.pitchDeg;
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, Rh, 0, Math.PI * 2); ctx.clip();
    ctx.rotate(-roll);
    // bank scale rotates with the card
    ctx.strokeStyle = GAUGE_COLORS.white; ctx.lineWidth = Math.max(1.5, fr * 0.02);
    for (const b of BANK_TICKS) {
      const a = (b - 90) * DEG, len = Math.abs(b) === 30 || Math.abs(b) === 60 ? fr * 0.12 : fr * 0.07;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * Rh, Math.sin(a) * Rh);
      ctx.lineTo(Math.cos(a) * (Rh - len), Math.sin(a) * (Rh - len));
      ctx.stroke();
    }
    ctx.translate(0, pitch * pxPerDeg);
    const big = size * 3;
    ctx.fillStyle = GAUGE_COLORS.sky; ctx.fillRect(-big, -big, big * 2, big);
    ctx.fillStyle = GAUGE_COLORS.ground; ctx.fillRect(-big, 0, big * 2, big);
    ctx.strokeStyle = GAUGE_COLORS.white; ctx.lineWidth = Math.max(1.5, fr * 0.02);
    ctx.beginPath(); ctx.moveTo(-big, 0); ctx.lineTo(big, 0); ctx.stroke();
    // pitch ladder ±30°
    ctx.font = gaugeFont(fr * 0.11); ctx.fillStyle = GAUGE_COLORS.white; ctx.textBaseline = 'middle';
    for (let p = -30; p <= 30; p += 5) {
      if (p === 0) continue;
      const y = -p * pxPerDeg;
      const w = p % 10 === 0 ? fr * 0.28 : fr * 0.14;
      ctx.beginPath(); ctx.moveTo(-w, y); ctx.lineTo(w, y); ctx.stroke();
      if (p % 10 === 0) {
        ctx.textAlign = 'right'; ctx.fillText(String(Math.abs(p)), -w - fr * 0.04, y);
        ctx.textAlign = 'left'; ctx.fillText(String(Math.abs(p)), w + fr * 0.04, y);
      }
    }
    // zero-bank triangle on the card
    ctx.restore();
    ctx.save();
    ctx.rotate(-roll);
    ctx.beginPath();
    ctx.moveTo(0, -Rh);
    ctx.lineTo(-fr * 0.045, -Rh + fr * 0.1);
    ctx.lineTo(fr * 0.045, -Rh + fr * 0.1);
    ctx.closePath();
    ctx.fillStyle = GAUGE_COLORS.white; ctx.fill();
    ctx.restore();
    // miniature aircraft (fixed)
    ctx.strokeStyle = GAUGE_COLORS.orange; ctx.lineWidth = Math.max(2, fr * 0.045); ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-fr * 0.45, 0); ctx.lineTo(-fr * 0.15, 0); ctx.lineTo(-fr * 0.08, fr * 0.08);
    ctx.moveTo(fr * 0.45, 0); ctx.lineTo(fr * 0.15, 0); ctx.lineTo(fr * 0.08, fr * 0.08);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, fr * 0.035, 0, Math.PI * 2); ctx.fillStyle = GAUGE_COLORS.orange; ctx.fill();
    if (!r.attitude.valid) drawFlag(ctx, -fr * 0.75, -fr * 0.45, fr * 0.4, fr * 0.16, 'GYRO');
    drawText(ctx, 'ATTITUDE', 0, fr * 0.78, gaugeFont(fr * 0.09), 'rgba(255,255,255,0.7)');
  }
}
