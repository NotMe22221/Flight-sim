/**
 * C172S engine and system gauges built on `ArcGauge`: tachometer (with tach-hour drum), fuel flow,
 * manifold pressure + fuel flow dual (182-class), fuel quantity L/R, oil temperature/pressure,
 * EGT, suction and ammeter. Markings per docs/research/05 §1.3.
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import { AMMETER, EGT, FUEL, FUEL_FLOW, MAP, OIL_PRESS, OIL_TEMP, SUCTION, TACH } from '../c172';
import { formatHours } from '../format';
import type { InstrumentReadings } from '../readings';
import { linearAngleDeg } from '../scales';
import { ArcGauge } from './ArcGauge';
import { Gauge } from './Gauge';
import { GAUGE_COLORS, drawArcBand, drawBezel, drawGlass, drawHub, drawNeedle, drawRadialLabel, drawText, drawTick, drawWindow, faceRadius, gaugeFont } from './common';

const SMALL = { startDeg: -60, sweepDeg: 120 } as const;

export class Tachometer extends ArcGauge {
  constructor(factory?: CanvasFactory) {
    super({
      min: TACH.min, max: TACH.max, startDeg: -TACH.sweepDeg / 2, sweepDeg: TACH.sweepDeg,
      bands: [{ from: TACH.greenLo, to: TACH.greenHi, color: GAUGE_COLORS.green }], redlines: [TACH.redline],
      majorStep: 500, minorStep: 100, labelStep: 500, labelDivisor: 100, title: 'RPM', unit: 'HUNDREDS',
    }, (r) => r.engine.rpm, factory);
  }
  protected override paintExtraStatic(ctx: Ctx2D, size: number, fr: number): void {
    drawWindow(ctx, size / 2 - fr * 0.32, size / 2 + fr * 0.12, fr * 0.64, fr * 0.2);
  }
  protected override paintBeforeNeedle(ctx: Ctx2D, _size: number, fr: number, r: InstrumentReadings): void {
    drawText(ctx, formatHours(r.tachHours), 0, fr * 0.22, gaugeFont(fr * 0.15), GAUGE_COLORS.white);
  }
}

export class FuelFlowGauge extends ArcGauge {
  constructor(factory?: CanvasFactory) {
    super({
      min: FUEL_FLOW.min, max: FUEL_FLOW.max, ...SMALL, bands: [{ from: FUEL_FLOW.greenLo, to: FUEL_FLOW.greenHi, color: GAUGE_COLORS.green }],
      majorStep: 5, minorStep: 1, labelStep: 5, title: 'FUEL FLOW', unit: 'GAL/HR',
    }, (r) => r.engine.fuelFlowGph, factory);
  }
}

export class FuelQuantityGauge extends ArcGauge {
  constructor(side: 'left' | 'right', factory?: CanvasFactory) {
    super({
      min: 0, max: FUEL.maxGal, ...SMALL, redlines: [0],
      majorStep: FUEL.maxGal / 2, minorStep: FUEL.maxGal / 4, labelStep: FUEL.maxGal / 2,
      labelFormat: (v) => (v <= 0 ? 'E' : v >= FUEL.maxGal - 1e-6 ? 'F' : '½'),
      title: side === 'left' ? 'LEFT' : 'RIGHT', subtitle: 'FUEL QTY', unit: 'GAL',
    }, side === 'left' ? (r) => r.fuelGal[0] : (r) => r.fuelGal[1], factory);
  }
}

export class OilTemperatureGauge extends ArcGauge {
  constructor(factory?: CanvasFactory) {
    super({
      min: OIL_TEMP.min, max: OIL_TEMP.max, ...SMALL, bands: [{ from: OIL_TEMP.greenLo, to: OIL_TEMP.greenHi, color: GAUGE_COLORS.green }], redlines: [OIL_TEMP.redline],
      majorStep: 25, minorStep: 25, labelStep: 50, tickMin: 75, labelMin: 100, title: 'OIL TEMP', unit: '°F',
    }, (r) => r.engine.oilTempF, factory);
  }
}

export class OilPressureGauge extends ArcGauge {
  constructor(factory?: CanvasFactory) {
    super({
      min: OIL_PRESS.min, max: OIL_PRESS.max, ...SMALL, bands: [{ from: OIL_PRESS.greenLo, to: OIL_PRESS.greenHi, color: GAUGE_COLORS.green }], redlines: [OIL_PRESS.redLo, OIL_PRESS.redHi],
      majorStep: 25, minorStep: 5, labelStep: 25, title: 'OIL PRESS', unit: 'PSI',
    }, (r) => r.engine.oilPressPsi, factory);
  }
}

export class EgtGauge extends ArcGauge {
  constructor(factory?: CanvasFactory) {
    super({
      min: EGT.min, max: EGT.max, ...SMALL, majorStep: 100, minorStep: EGT.divF, labelStep: 100, labelDivisor: 100,
      title: 'EGT', unit: `${EGT.divF}°F / DIV`,
    }, (r) => r.engine.egtF, factory);
  }
}

export class SuctionGauge extends ArcGauge {
  constructor(factory?: CanvasFactory) {
    super({
      min: SUCTION.min, max: SUCTION.max, ...SMALL, bands: [{ from: SUCTION.greenLo, to: SUCTION.greenHi, color: GAUGE_COLORS.green }],
      majorStep: 1, minorStep: 0.5, labelStep: 1, title: 'SUCTION', unit: 'IN HG',
    }, (r) => r.suctionInHg, factory);
  }
}

export class Ammeter extends ArcGauge {
  constructor(factory?: CanvasFactory) {
    super({
      min: AMMETER.min, max: AMMETER.max, ...SMALL, majorStep: 30, minorStep: 10, labelStep: 30,
      labelFormat: (v) => String(Math.abs(v)), title: 'AMPS', unit: 'D          C',
    }, (r) => r.ampsA, factory);
  }
}

/** Dual manifold-pressure (outer scale) + fuel-flow (inner scale) gauge for constant-speed types. */
export class ManifoldFuelFlowGauge extends Gauge {
  constructor(factory?: CanvasFactory) { super(factory); }
  private mapAngle(v: number): number { return linearAngleDeg(v, MAP.min, MAP.max, -135, 270); }
  private ffAngle(v: number): number { return linearAngleDeg(v, FUEL_FLOW.min, FUEL_FLOW.max, -135, 270); }

  protected paintStatic(ctx: Ctx2D, size: number): void {
    const cx = size / 2, cy = size / 2, R = size / 2;
    drawBezel(ctx, cx, cy, R);
    const fr = faceRadius(R);
    drawArcBand(ctx, cx, cy, fr * 0.86, this.mapAngle(MAP.greenLo), this.mapAngle(MAP.greenHi), fr * 0.08, GAUGE_COLORS.green);
    for (let v = MAP.min; v <= MAP.max; v += 1) drawTick(ctx, cx, cy, this.mapAngle(v), fr * 0.92, v % 5 === 0 ? fr * 0.14 : fr * 0.07, v % 5 === 0 ? 2 : 1, GAUGE_COLORS.white);
    for (let v = MAP.min; v <= MAP.max; v += 5) drawRadialLabel(ctx, cx, cy, this.mapAngle(v), fr * 0.7, String(v), gaugeFont(fr * 0.15, true), GAUGE_COLORS.white);
    for (let v = FUEL_FLOW.min; v <= FUEL_FLOW.max; v += 2) drawTick(ctx, cx, cy, this.ffAngle(v), fr * 0.5, v % 10 === 0 ? fr * 0.1 : fr * 0.05, 1, GAUGE_COLORS.yellow);
    for (let v = FUEL_FLOW.min; v <= FUEL_FLOW.max; v += 10) drawRadialLabel(ctx, cx, cy, this.ffAngle(v), fr * 0.3, String(v), gaugeFont(fr * 0.11, true), GAUGE_COLORS.yellow);
    drawText(ctx, 'MAN PRESS', cx, cy - fr * 0.55, gaugeFont(fr * 0.1, true), GAUGE_COLORS.white);
    drawText(ctx, 'IN HG', cx, cy - fr * 0.44, gaugeFont(fr * 0.08), GAUGE_COLORS.grey);
    drawText(ctx, 'FUEL FLOW GPH', cx, cy + fr * 0.58, gaugeFont(fr * 0.08), GAUGE_COLORS.yellow);
    drawGlass(ctx, cx, cy, fr);
  }

  protected paintDynamic(ctx: Ctx2D, size: number, r: InstrumentReadings): void {
    const fr = faceRadius(size / 2);
    drawNeedle(ctx, this.ffAngle(r.engine.fuelFlowGph), fr * 0.5, fr * 0.1, Math.max(3, fr * 0.07), GAUGE_COLORS.yellow);
    drawNeedle(ctx, this.mapAngle(r.engine.mapInHg), fr * 0.86, fr * 0.15, Math.max(3, fr * 0.06));
    drawHub(ctx, Math.max(4, fr * 0.09));
  }
}
