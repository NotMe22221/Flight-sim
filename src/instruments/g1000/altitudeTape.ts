/**
 * PFD altitude tape: 600 ft visible (0.75 px/ft), ticks every 20 ft, labels every 100 ft, rolling
 * tens drum, selected-altitude bug + box, baro box, 6 s trend vector and the glideslope/vertical
 * deviation indicator drawn just left of the tape when an ILS is received.
 */
import { clamp } from '../../core/math';
import { M_TO_FT } from '../../core/units';
import type { AutopilotState, NavRadioState } from '../../core/types';
import type { Ctx2D } from '../canvas';
import type { InstrumentReadings } from '../readings';
import { forEachTick, tapeOffsetPx } from '../scales';
import { G, PFD, cond, condBold } from './palette';
import { baroInLabels, hundredsLabels, thousandsLabels } from './labels';
import { TWENTIES, box, bug, drum, num, pointerWindow, text } from './widgets';

export function drawAltitudeTape(ctx: Ctx2D, r: InstrumentReadings, ap: AutopilotState, nav: NavRadioState | null): void {
  const x = PFD.altX, w = PFD.altW, top = PFD.tapeTop, bottom = PFD.tapeBottom, k = PFD.altPxPerFt;
  const mid = (top + bottom) / 2, half = (bottom - top) / 2;
  const alt = r.altimeter.indicatedFt;
  box(ctx, x, top, w, bottom - top, G.tapeBg);
  ctx.save();
  ctx.beginPath(); ctx.rect(x - 14, top, w + 14, bottom - top); ctx.clip();
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  ctx.font = condBold.get(18); ctx.fillStyle = G.white; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  forEachTick(alt, 20, k, half + 10, -1000, 60000, (val, off) => {
    const y = mid + off, major = val % 100 === 0;
    ctx.beginPath(); ctx.moveTo(x + 8, y); ctx.lineTo(x + (major ? 22 : 15), y); ctx.stroke();
    if (major) ctx.fillText(thousandsLabels.get(val), x + 26, y);
  });
  // selected altitude bug
  const selFt = ap.altitudeTargetM * M_TO_FT;
  bug(ctx, x, clamp(mid + tapeOffsetPx(selFt, alt, k), top + 8, bottom - 8), 9, 'left');
  // trend vector on the left edge
  const trend = r.trends.altFtPer6s;
  if (Math.abs(trend) > 5) {
    const len = clamp(-trend * k, -half, half);
    ctx.fillStyle = G.magenta; ctx.fillRect(x, Math.min(mid, mid + len), 6, Math.abs(len));
  }
  ctx.restore();
  // window: hundreds static, tens drum (20 ft)
  const ww = 90, wh = 52;
  pointerWindow(ctx, x - 2, mid - wh / 2, ww, wh, 'left');
  ctx.save();
  ctx.beginPath(); ctx.rect(x + 8, mid - wh / 2 + 2, ww - 12, wh - 4); ctx.clip();
  const neg = alt < 0, a = Math.abs(alt);
  const hundreds = Math.floor(a / 100);
  num(ctx, neg && hundreds === 0 ? '-' : hundredsLabels.get(neg ? -hundreds : hundreds), x + 48, mid, condBold.get(26), G.white, 'right');
  drum(ctx, x + 66, mid, 34, (a % 100) / 20, TWENTIES, condBold.get(22), G.white, 'center');
  ctx.restore();
  // selected altitude box above, baro below
  box(ctx, x, top - 26, w, 24);
  num(ctx, thousandsLabels.get(Math.round(selFt / 100) * 100), x + w - 6, top - 14, condBold.get(18), G.cyan, 'right');
  box(ctx, x, bottom + 2, w, 24);
  num(ctx, baroInLabels.get(r.altimeter.settingInHg), x + w - 6, bottom + 14, condBold.get(16), G.cyan, 'right');
  // vertical deviation (glideslope) scale left of the tape
  if (nav && nav.isLocalizer && nav.gsValid) {
    const gx = x - 20, gy = mid;
    box(ctx, gx - 10, top + 40, 20, bottom - top - 80, G.tapeBg);
    text(ctx, 'G', gx, top + 52, condBold.get(13), G.green, 'center');
    ctx.strokeStyle = G.white; ctx.lineWidth = 1.5;
    for (let i = -2; i <= 2; i++) {
      if (i === 0) { ctx.beginPath(); ctx.moveTo(gx - 8, gy); ctx.lineTo(gx + 8, gy); ctx.stroke(); continue; }
      ctx.beginPath(); ctx.arc(gx, gy + i * 60, 4, 0, Math.PI * 2); ctx.stroke();
    }
    const dy = clamp(-nav.gsDeviation, -1.2, 1.2) * 120;
    ctx.fillStyle = G.green;
    ctx.beginPath(); ctx.moveTo(gx, gy + dy - 9); ctx.lineTo(gx + 8, gy + dy); ctx.lineTo(gx, gy + dy + 9); ctx.lineTo(gx - 8, gy + dy); ctx.closePath(); ctx.fill();
  }
  void cond;
}
