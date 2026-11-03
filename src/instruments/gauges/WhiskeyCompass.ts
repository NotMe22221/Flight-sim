/**
 * Wet magnetic compass viewed through its window: a horizontal card strip (±30° visible) behind a
 * lubber line. The card dynamics (turning/acceleration errors, overshoot) live in `compass.ts`.
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import { deltaDeg } from '../../core/math';
import type { InstrumentReadings } from '../readings';
import { Gauge } from './Gauge';
import { GAUGE_COLORS, drawText, gaugeFont } from './common';

const LABELS = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'];

export class WhiskeyCompassGauge extends Gauge {
  override readonly aspect = 0.42;
  constructor(factory?: CanvasFactory) { super(factory); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    const h = size * this.aspect;
    ctx.fillStyle = GAUGE_COLORS.bezel; ctx.fillRect(0, 0, size, h);
    ctx.fillStyle = '#0a0a0c'; ctx.fillRect(size * 0.04, h * 0.12, size * 0.92, h * 0.7);
    drawText(ctx, 'MAGNETIC COMPASS', size / 2, h * 0.92, gaugeFont(h * 0.11), GAUGE_COLORS.grey);
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const h = size * this.aspect;
    const wx = size * 0.46, top = -h / 2 + h * 0.12, bottom = top + h * 0.7;
    const pxPerDeg = (wx * 2) / 70;
    ctx.save();
    ctx.beginPath(); ctx.rect(-wx, top, wx * 2, bottom - top); ctx.clip();
    const hdg = r.heading.compassDeg;
    const first = Math.ceil((hdg - 36) / 5) * 5;
    ctx.strokeStyle = GAUGE_COLORS.white; ctx.lineWidth = 1;
    ctx.font = gaugeFont(h * 0.26, true); ctx.fillStyle = GAUGE_COLORS.white; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let d = first; d <= hdg + 36; d += 5) {
      const x = -deltaDeg(hdg, d) * pxPerDeg;
      const major = d % 10 === 0;
      ctx.beginPath(); ctx.moveTo(x, bottom); ctx.lineTo(x, bottom - (major ? h * 0.18 : h * 0.1)); ctx.stroke();
      if (d % 30 === 0) ctx.fillText(LABELS[(((d / 30) % 12) + 12) % 12], x, top + h * 0.3);
    }
    ctx.restore();
    ctx.fillStyle = GAUGE_COLORS.orange;
    ctx.fillRect(-Math.max(1, h * 0.02), top, Math.max(2, h * 0.04), (bottom - top) * 0.45);
  }
}
