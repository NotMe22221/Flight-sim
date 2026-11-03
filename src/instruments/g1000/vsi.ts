/**
 * PFD vertical speed indicator: fixed ±2 000 fpm scale (0.075 px/fpm), pointer with digits when
 * |VS| > 100 fpm, clamped at the scale ends, selected-VS bug in VS mode.
 */
import { clamp } from '../../core/math';
import { MS_TO_FPM } from '../../core/units';
import type { AutopilotState } from '../../core/types';
import type { Ctx2D } from '../canvas';
import type { InstrumentReadings } from '../readings';
import { G, PFD, cond, condBold } from './palette';
import { intLabels, thousandsDigitLabels } from './labels';
import { box, bug, num, text } from './widgets';

export function drawVsi(ctx: Ctx2D, r: InstrumentReadings, ap: AutopilotState): void {
  const x = PFD.vsiX, w = PFD.vsiW, k = PFD.vsiPxPerFpm;
  const mid = (PFD.tapeTop + PFD.tapeBottom) / 2;
  const top = mid - 2000 * k - 20, h = 4000 * k + 40;
  box(ctx, x, top, w, h, G.tapeBg);
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  for (let v = -2000; v <= 2000; v += 500) {
    const y = mid - v * k, major = v % 1000 === 0;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (major ? 12 : 7), y); ctx.stroke();
    if (major && v !== 0) text(ctx, thousandsDigitLabels.get(v), x + 18, y, condBold.get(16), G.white, 'left');
  }
  if (ap.vertical === 'VS') bug(ctx, x, clamp(mid - ap.verticalSpeedTargetMs * MS_TO_FPM * k, mid - 2000 * k, mid + 2000 * k), 7, 'left');
  // the glass VSI is driven by the air-data computer, not the lagging steam-VSI model
  const vs = clamp(r.adcVsFpm, -2000, 2000);
  const y = mid - vs * k;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 10, y - 9); ctx.lineTo(x + w - 2, y - 9); ctx.lineTo(x + w - 2, y + 9); ctx.lineTo(x + 10, y + 9); ctx.closePath();
  ctx.fillStyle = G.black; ctx.fill(); ctx.strokeStyle = G.white; ctx.lineWidth = 1.5; ctx.stroke();
  if (Math.abs(r.adcVsFpm) > 100) num(ctx, intLabels.get(Math.round(r.adcVsFpm / 50) * 50), x + w - 5, y, condBold.get(14), G.white, 'right');
  void cond;
}
