/**
 * Directional gyro: rotating compass card (cached as its own layer and rotated per frame), fixed
 * lubber line and 45° reference marks, orange heading bug, fixed aircraft symbol, OFF flag.
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import { StaticLayer } from '../canvas';
import { DEG } from '../../core/units';
import type { InstrumentReadings } from '../readings';
import { dialRad } from '../scales';
import { Gauge } from './Gauge';
import { GAUGE_COLORS, drawBezel, drawFlag, drawGlass, drawRadialLabel, drawTick, faceRadius, gaugeFont } from './common';

const CARD_LABELS = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'];

/** Paint a compass rose (ticks every 5°, labels every 30°) centred in a `size` square. */
export function paintCompassCard(ctx: Ctx2D, size: number, radius: number, labelFrac = 0.78, cardinalScale = 1.25): void {
  const cx = size / 2, cy = size / 2;
  for (let d = 0; d < 360; d += 5) {
    const major = d % 10 === 0;
    drawTick(ctx, cx, cy, d, radius, major ? radius * 0.14 : radius * 0.07, major ? 2 : 1, GAUGE_COLORS.white);
  }
  for (let i = 0; i < 12; i++) {
    const cardinal = i % 3 === 0;
    drawRadialLabel(ctx, cx, cy, i * 30, radius * labelFrac, CARD_LABELS[i], gaugeFont(radius * 0.16 * (cardinal ? cardinalScale : 1), true), GAUGE_COLORS.white);
  }
}

export class HeadingIndicator extends Gauge {
  private readonly card: StaticLayer;
  constructor(factory?: CanvasFactory) {
    super(factory);
    this.card = new StaticLayer(this.factory);
  }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    const cx = size / 2, cy = size / 2, R = size / 2;
    drawBezel(ctx, cx, cy, R);
    const fr = faceRadius(R);
    for (let d = 45; d < 360; d += 45) {
      const a = dialRad(d), r0 = fr * 0.98, r1 = fr * 0.9;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0 - Math.sin(a) * fr * 0.03, cy + Math.sin(a) * r0 + Math.cos(a) * fr * 0.03);
      ctx.lineTo(cx + Math.cos(a) * r0 + Math.sin(a) * fr * 0.03, cy + Math.sin(a) * r0 - Math.cos(a) * fr * 0.03);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.closePath(); ctx.fillStyle = GAUGE_COLORS.white; ctx.fill();
    }
    // lubber line
    ctx.fillStyle = GAUGE_COLORS.white;
    ctx.fillRect(cx - Math.max(1, fr * 0.02), cy - fr * 0.99, Math.max(2, fr * 0.04), fr * 0.18);
    drawGlass(ctx, cx, cy, fr);
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const fr = faceRadius(size / 2);
    const cardR = fr * 0.86, cardSize = Math.ceil(cardR * 2 + 4), pr = this.pixelRatio;
    const img = this.card.get(cardSize * pr, cardSize * pr, 0, (c) => { c.scale(pr, pr); paintCompassCard(c, cardSize, cardR); });
    const hdg = r.heading.dgDeg * DEG;
    ctx.save();
    ctx.rotate(-hdg);
    if (img) ctx.drawImage(img, -cardSize / 2, -cardSize / 2, cardSize, cardSize);
    else { ctx.translate(-cardSize / 2, -cardSize / 2); paintCompassCard(ctx, cardSize, cardR); ctx.translate(cardSize / 2, cardSize / 2); }
    // heading bug on the card rim
    ctx.rotate(r.heading.bugDeg * DEG);
    ctx.fillStyle = GAUGE_COLORS.orange;
    ctx.beginPath();
    ctx.moveTo(-fr * 0.08, -cardR - fr * 0.02);
    ctx.lineTo(-fr * 0.03, -cardR + fr * 0.08);
    ctx.lineTo(fr * 0.03, -cardR + fr * 0.08);
    ctx.lineTo(fr * 0.08, -cardR - fr * 0.02);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    // fixed aircraft symbol
    ctx.strokeStyle = GAUGE_COLORS.white; ctx.lineWidth = Math.max(2, fr * 0.04); ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -fr * 0.3); ctx.lineTo(0, fr * 0.25);
    ctx.moveTo(-fr * 0.3, 0); ctx.lineTo(fr * 0.3, 0);
    ctx.moveTo(-fr * 0.12, fr * 0.22); ctx.lineTo(fr * 0.12, fr * 0.22);
    ctx.stroke();
    if (!r.heading.dgValid) drawFlag(ctx, fr * 0.25, -fr * 0.6, fr * 0.35, fr * 0.14, 'OFF');
  }

  override dispose(): void { super.dispose(); this.card.dispose(); }
}
