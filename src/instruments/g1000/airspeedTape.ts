/**
 * PFD airspeed tape: 60 kt visible (7.5 px/kt), labels every 10, ticks every 5, POH colour bands,
 * V-speed bugs, 6 s magenta trend vector, rolling-digit window, TAS readout and FLC target bug.
 */
import { clamp } from '../../core/math';
import { MS_TO_KT } from '../../core/units';
import type { AutopilotState } from '../../core/types';
import type { Ctx2D } from '../canvas';
import type { VSpeeds } from '../c172';
import type { InstrumentReadings } from '../readings';
import { forEachTick, tapeOffsetPx } from '../scales';
import { G, PFD, cond, condBold } from './palette';
import { intLabels, ktLabels } from './labels';
import { DIGITS, box, bug, drum, num, pointerWindow, text } from './widgets';

const MIN_KT = 20, MAX_KT = 300;

export function drawAirspeedTape(ctx: Ctx2D, r: InstrumentReadings, ap: AutopilotState, v: VSpeeds): void {
  const x = PFD.asX, w = PFD.asW, top = PFD.tapeTop, bottom = PFD.tapeBottom, k = PFD.asPxPerKt;
  const mid = (top + bottom) / 2, half = (bottom - top) / 2;
  const ias = Math.max(MIN_KT, r.iasKt);
  box(ctx, x, top, w, bottom - top, G.tapeBg);
  ctx.save();
  ctx.beginPath(); ctx.rect(x, top, w + 14, bottom - top); ctx.clip();
  // colour bands along the right edge
  const bandX = x + w - 6;
  band(ctx, bandX, mid, ias, k, half, v.vso, v.vfe, G.white, 3);
  band(ctx, bandX + 3, mid, ias, k, half, v.vs1, v.vno, G.green, 3);
  band(ctx, bandX + 3, mid, ias, k, half, v.vno, v.vne, G.yellow, 3);
  band(ctx, bandX, mid, ias, k, half, v.vne, MAX_KT, G.red, 6);
  if (!r.onGround) band(ctx, bandX, mid, ias, k, half, MIN_KT, v.vs1, G.red, 6);
  // ticks and labels
  ctx.strokeStyle = G.white; ctx.lineWidth = 2;
  ctx.font = condBold.get(18); ctx.fillStyle = G.white; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  forEachTick(ias, 5, k, half + 10, MIN_KT, MAX_KT, (val, off) => {
    const y = mid + off, major = val % 10 === 0;
    ctx.beginPath(); ctx.moveTo(x + w - 8, y); ctx.lineTo(x + w - (major ? 22 : 15), y); ctx.stroke();
    if (major) ctx.fillText(intLabels.get(val), x + w - 28, y);
  });
  // V-speed bugs (labels on the right of the tape)
  vbug(ctx, x + w, mid + tapeOffsetPx(v.vr, ias, k), 'R', half, mid);
  vbug(ctx, x + w, mid + tapeOffsetPx(v.vx, ias, k), 'X', half, mid);
  vbug(ctx, x + w, mid + tapeOffsetPx(v.vy, ias, k), 'Y', half, mid);
  vbug(ctx, x + w, mid + tapeOffsetPx(v.vglide, ias, k), 'G', half, mid);
  // FLC selected airspeed bug
  if (ap.vertical === 'FLC' && ap.iasTargetMs > 0) bug(ctx, x + w, clamp(mid + tapeOffsetPx(ap.iasTargetMs * MS_TO_KT, ias, k), top + 6, bottom - 6), 8, 'right');
  // trend vector
  const trend = r.trends.iasKtPer6s;
  if (Math.abs(trend) > 0.5 && r.iasKt > MIN_KT) {
    const len = clamp(-trend * k, -half, half);
    ctx.fillStyle = G.magenta; ctx.fillRect(x + w - 6, Math.min(mid, mid + len), 6, Math.abs(len));
  }
  ctx.restore();
  // current-speed window
  const ww = 86, wh = 46;
  pointerWindow(ctx, x + 2, mid - wh / 2, ww, wh, 'right');
  ctx.save();
  ctx.beginPath(); ctx.rect(x + 2, mid - wh / 2 + 2, ww - 2, wh - 4); ctx.clip();
  if (r.iasKt >= MIN_KT) {
    const whole = Math.floor(r.iasKt);
    const tens = Math.floor(whole / 10);
    if (tens > 0) num(ctx, intLabels.get(tens), x + 50, mid, condBold.get(26), G.white, 'right');
    drum(ctx, x + 60, mid, 30, r.iasKt % 10, DIGITS, condBold.get(26), G.white, 'center');
  } else text(ctx, '---', x + 50, mid, condBold.get(26), G.white, 'center');
  ctx.restore();
  // TAS
  box(ctx, x, bottom + 2, w, 24);
  text(ctx, 'TAS', x + 4, bottom + 14, cond.get(14), G.white);
  num(ctx, ktLabels.get(r.tasKt), x + w - 4, bottom + 14, condBold.get(16), G.white, 'right');
  // selected airspeed readout above (FLC)
  if (ap.vertical === 'FLC' && ap.iasTargetMs > 0) {
    box(ctx, x, top - 26, w, 24);
    num(ctx, ktLabels.get(ap.iasTargetMs * MS_TO_KT), x + w - 4, top - 14, condBold.get(16), G.cyan, 'right');
  }
}

function band(ctx: Ctx2D, x: number, mid: number, ias: number, k: number, half: number, from: number, to: number, color: string, width: number): void {
  const y0 = clamp(mid + tapeOffsetPx(to, ias, k), mid - half, mid + half);
  const y1 = clamp(mid + tapeOffsetPx(from, ias, k), mid - half, mid + half);
  if (y1 <= y0) return;
  ctx.fillStyle = color; ctx.fillRect(x, y0, width, y1 - y0);
}

function vbug(ctx: Ctx2D, x: number, y: number, label: string, half: number, mid: number): void {
  if (Math.abs(y - mid) > half - 8) return;
  ctx.fillStyle = G.white; ctx.fillRect(x - 6, y - 1.5, 6, 3);
  text(ctx, label, x + 3, y, condBold.get(13), G.white, 'left');
}
