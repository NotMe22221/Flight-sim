/**
 * Digital clock (UTC), elapsed timer and OAT in °C / °F, like the Davtron M803 fitted to many 172s.
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import { fillTabular } from '../canvas';
import { formatTimer, formatUtc } from '../format';
import { LabelCache } from '../labelCache';
import type { InstrumentReadings } from '../readings';
import { Gauge } from './Gauge';
import { GAUGE_COLORS, drawText, gaugeFont } from './common';

// memoised readouts: the panel redraws at 30 Hz and the values change at most once a second
const utcLabels = new LabelCache(formatUtc, 1000);
const timerLabels = new LabelCache(formatTimer);
const degC = new LabelCache((v) => `${v}°C`);
const degF = new LabelCache((v) => `${v}°F`);

export class ClockOat extends Gauge {
  override readonly aspect = 0.55;
  constructor(factory?: CanvasFactory) { super(factory); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    const h = size * this.aspect;
    ctx.fillStyle = GAUGE_COLORS.bezel; ctx.fillRect(0, 0, size, h);
    ctx.fillStyle = '#06100a'; ctx.fillRect(size * 0.05, h * 0.1, size * 0.9, h * 0.8);
    drawText(ctx, 'UTC', size * 0.1, h * 0.22, gaugeFont(h * 0.12), GAUGE_COLORS.grey, 'left');
    drawText(ctx, 'OAT', size * 0.1, h * 0.58, gaugeFont(h * 0.12), GAUGE_COLORS.grey, 'left');
    drawText(ctx, 'TMR', size * 0.6, h * 0.58, gaugeFont(h * 0.12), GAUGE_COLORS.grey, 'left');
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const h = size * this.aspect;
    const green = '#8ff08a';
    ctx.fillStyle = green; ctx.textBaseline = 'middle';
    ctx.font = gaugeFont(h * 0.28, true);
    fillTabular(ctx, utcLabels.get(r.clock.utcMs), size * 0.42, -h / 2 + h * 0.3, 'right');
    // OAT °C, °F and the timer side by side: sized so '-40°C −40°F 00:00' never runs together
    ctx.font = gaugeFont(h * 0.17, true);
    fillTabular(ctx, degC.get(r.oatC), -size / 2 + size * 0.08, -h / 2 + h * 0.78, 'left');
    fillTabular(ctx, degF.get(r.oatC * 1.8 + 32), -size / 2 + size * 0.31, -h / 2 + h * 0.78, 'left');
    fillTabular(ctx, timerLabels.get(r.clock.timerS), -size / 2 + size * 0.6, -h / 2 + h * 0.78, 'left');
  }
}
