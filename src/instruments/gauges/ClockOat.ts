/**
 * Digital clock (UTC), elapsed timer and OAT in °C / °F, like the Davtron M803 fitted to many 172s.
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import { fillTabular } from '../canvas';
import { formatTimer, formatUtc } from '../format';
import type { InstrumentReadings } from '../readings';
import { Gauge } from './Gauge';
import { GAUGE_COLORS, drawText, gaugeFont } from './common';

export class ClockOat extends Gauge {
  override readonly aspect = 0.55;
  constructor(factory?: CanvasFactory) { super(factory); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    const h = size * this.aspect;
    ctx.fillStyle = GAUGE_COLORS.bezel; ctx.fillRect(0, 0, size, h);
    ctx.fillStyle = '#06100a'; ctx.fillRect(size * 0.05, h * 0.1, size * 0.9, h * 0.8);
    drawText(ctx, 'UTC', size * 0.1, h * 0.22, gaugeFont(h * 0.12), GAUGE_COLORS.grey, 'left');
    drawText(ctx, 'OAT', size * 0.1, h * 0.58, gaugeFont(h * 0.12), GAUGE_COLORS.grey, 'left');
    drawText(ctx, 'TMR', size * 0.55, h * 0.58, gaugeFont(h * 0.12), GAUGE_COLORS.grey, 'left');
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const h = size * this.aspect;
    const green = '#8ff08a';
    ctx.fillStyle = green; ctx.textBaseline = 'middle';
    ctx.font = gaugeFont(h * 0.28, true);
    fillTabular(ctx, formatUtc(r.clock.utcMs), size * 0.42, -h / 2 + h * 0.3, 'right');
    ctx.font = gaugeFont(h * 0.2, true);
    fillTabular(ctx, `${Math.round(r.oatC)}°C`, -size / 2 + size * 0.1, -h / 2 + h * 0.78, 'left');
    fillTabular(ctx, `${Math.round(r.oatC * 1.8 + 32)}°F`, -size / 2 + size * 0.28, -h / 2 + h * 0.78, 'left');
    fillTabular(ctx, formatTimer(r.clock.timerS), -size / 2 + size * 0.55, -h / 2 + h * 0.78, 'left');
  }
}
