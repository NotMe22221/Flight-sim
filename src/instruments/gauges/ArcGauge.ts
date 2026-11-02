/**
 * Generic round gauge with a linear (or custom) scale, coloured bands, radial ticks, labels and a
 * single needle. The engine cluster and the airspeed/VSI dials are specialisations of this.
 */
import type { Ctx2D } from '../canvas';
import type { InstrumentReadings } from '../readings';
import { linearAngleDeg } from '../scales';
import { Gauge } from './Gauge';
import { GAUGE_COLORS, drawArcBand, drawBezel, drawGlass, drawHub, drawNeedle, drawRadialLabel, drawText, drawTick, faceRadius, gaugeFont } from './common';

export interface ArcBand { from: number; to: number; color: string; /** radius as a fraction of the face radius (default 0.86) */ radiusFrac?: number }

export interface ArcGaugeSpec {
  min: number; max: number;
  /** dial angle of `min` (deg, 0 = 12 o'clock, clockwise) and total sweep */
  startDeg: number; sweepDeg: number;
  bands?: ArcBand[];
  /** values that get a red radial line */
  redlines?: number[];
  majorStep: number; minorStep: number; labelStep: number;
  /** first tick / label value (default `min`; the ASI has a dead sector below 40 kt) */
  tickMin?: number; labelMin?: number;
  /** label text for a value (default: value / labelDivisor) */
  labelDivisor?: number;
  labelFormat?: (value: number) => string;
  title?: string; subtitle?: string; unit?: string;
  /** custom value → dial angle (overrides the linear mapping) */
  angleOf?: (value: number) => number;
  /** needle length as a fraction of the face radius */
  needleFrac?: number;
  /** label radius as a fraction of the face radius */
  labelFrac?: number;
}

export class ArcGauge extends Gauge {
  constructor(public readonly spec: ArcGaugeSpec, private readonly read: (r: InstrumentReadings) => number, factory?: ConstructorParameters<typeof Gauge>[0]) {
    super(factory);
  }

  /** Dial angle for a value. */
  angleOf(value: number): number {
    const s = this.spec;
    return s.angleOf ? s.angleOf(value) : linearAngleDeg(value, s.min, s.max, s.startDeg, s.sweepDeg);
  }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    const s = this.spec, cx = size / 2, cy = size / 2, R = size / 2;
    drawBezel(ctx, cx, cy, R);
    const fr = faceRadius(R);
    const bandR = fr * 0.86, bandW = Math.max(3, fr * 0.09);
    for (const b of s.bands ?? []) drawArcBand(ctx, cx, cy, b.radiusFrac !== undefined ? fr * b.radiusFrac : bandR, this.angleOf(b.from), this.angleOf(b.to), bandW, b.color);
    const tickR = fr * 0.92;
    const major = Math.max(2, fr * 0.025), minor = Math.max(1, fr * 0.015);
    for (let v = s.tickMin ?? s.min; v <= s.max + 1e-9; v += s.minorStep) {
      const isMajor = Math.abs(v / s.majorStep - Math.round(v / s.majorStep)) < 1e-6;
      drawTick(ctx, cx, cy, this.angleOf(v), tickR, isMajor ? fr * 0.14 : fr * 0.08, isMajor ? major : minor, GAUGE_COLORS.white);
    }
    for (const v of s.redlines ?? []) drawTick(ctx, cx, cy, this.angleOf(v), tickR + fr * 0.02, fr * 0.2, Math.max(2, fr * 0.04), GAUGE_COLORS.red);
    const font = gaugeFont(fr * 0.17, true), lr = fr * (s.labelFrac ?? 0.66);
    for (let v = s.labelMin ?? s.min; v <= s.max + 1e-9; v += s.labelStep) {
      const text = s.labelFormat ? s.labelFormat(v) : String(Math.round(v / (s.labelDivisor ?? 1)));
      drawRadialLabel(ctx, cx, cy, this.angleOf(v), lr, text, font, GAUGE_COLORS.white);
    }
    if (s.title) drawText(ctx, s.title, cx, cy - fr * 0.3, gaugeFont(fr * 0.13, true), GAUGE_COLORS.text);
    if (s.subtitle) drawText(ctx, s.subtitle, cx, cy - fr * 0.3 + fr * 0.15, gaugeFont(fr * 0.1), GAUGE_COLORS.grey);
    if (s.unit) drawText(ctx, s.unit, cx, cy + fr * 0.42, gaugeFont(fr * 0.11), GAUGE_COLORS.grey);
    this.paintExtraStatic(ctx, size, fr);
    drawGlass(ctx, cx, cy, fr);
  }

  /** Hook for subclasses to add static artwork (placards, windows). */
  protected paintExtraStatic(_ctx: Ctx2D, _size: number, _faceR: number): void { /* none */ }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const fr = faceRadius(size / 2);
    this.paintBeforeNeedle(ctx, size, fr, r);
    const v = this.read(r);
    drawNeedle(ctx, this.angleOf(Number.isFinite(v) ? v : this.spec.min), fr * (this.spec.needleFrac ?? 0.84), fr * 0.18, Math.max(3, fr * 0.07));
    drawHub(ctx, Math.max(4, fr * 0.1));
  }

  /** Hook for subclasses to draw dynamic parts beneath the needle (drums, flags). */
  protected paintBeforeNeedle(_ctx: Ctx2D, _size: number, _faceR: number, _r: InstrumentReadings): void { /* none */ }
}
