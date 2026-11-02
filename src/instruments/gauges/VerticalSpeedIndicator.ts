/**
 * Vertical speed indicator: ±2 000 fpm, zero at 9 o'clock, climb clockwise over the top. The lag is
 * in `InstrumentModel` (τ 2.5 s); this is just the dial.
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import { ArcGauge } from './ArcGauge';
import { GAUGE_COLORS, drawText, gaugeFont } from './common';

export class VerticalSpeedIndicator extends ArcGauge {
  constructor(factory?: CanvasFactory) {
    super({
      min: -2000, max: 2000, startDeg: 100, sweepDeg: 340,
      majorStep: 500, minorStep: 100, labelStep: 500,
      labelFormat: (v) => String(Math.abs(v) / 100),
      title: 'VERTICAL SPEED', unit: '100 FEET PER MINUTE', labelFrac: 0.68,
    }, (r) => r.vsiFpm, factory);
  }

  protected override paintExtraStatic(ctx: Ctx2D, size: number, fr: number): void {
    const cx = size / 2, cy = size / 2;
    drawText(ctx, 'UP', cx - fr * 0.42, cy - fr * 0.52, gaugeFont(fr * 0.1), GAUGE_COLORS.grey);
    drawText(ctx, 'DOWN', cx - fr * 0.42, cy + fr * 0.52, gaugeFont(fr * 0.1), GAUGE_COLORS.grey);
  }
}
