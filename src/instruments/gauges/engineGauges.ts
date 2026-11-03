/**
 * Engine and system gauges built on `ArcGauge`: tachometer (with tach-hour drum), fuel flow,
 * manifold pressure + fuel flow dual (182-class), fuel quantity L/R, oil temperature/pressure,
 * EGT, suction, ammeter and voltmeter. Default markings are the C172S's (docs/research/05 §1.3);
 * other aircraft pass theirs from their `PanelSpec` (panelSpec.ts).
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import { AMMETER, EGT, FUEL, FUEL_FLOW, MAP, OIL_PRESS, OIL_TEMP, SUCTION, TACH } from '../c172';
import { formatHours } from '../format';
import { LabelCache } from '../labelCache';
import type { InstrumentReadings } from '../readings';
import type { ElectricalMarkings, OilPressMarkings, OilTempMarkings, TachMarkings } from '../panelSpec';
import { linearAngleDeg } from '../scales';
import { ArcGauge } from './ArcGauge';
import { Gauge } from './Gauge';
import { GAUGE_COLORS, drawArcBand, drawBezel, drawGlass, drawHub, drawNeedle, drawRadialLabel, drawText, drawTick, drawWindow, faceRadius, gaugeFont } from './common';

const SMALL = { startDeg: -60, sweepDeg: 120 } as const;
const hourLabels = new LabelCache(formatHours, 0.1);

export class Tachometer extends ArcGauge {
  constructor(factory?: CanvasFactory, tach: Readonly<TachMarkings> = TACH) {
    super({
      min: tach.min, max: tach.max, startDeg: -tach.sweepDeg / 2, sweepDeg: tach.sweepDeg,
      bands: [{ from: tach.greenLo, to: tach.greenHi, color: GAUGE_COLORS.green }], redlines: [tach.redline],
      majorStep: 500, minorStep: 100, labelStep: 500, labelDivisor: 100, title: 'RPM', unit: 'HUNDREDS',
    }, (r) => r.engine.rpm, factory);
  }
  protected override paintExtraStatic(ctx: Ctx2D, size: number, fr: number): void {
    drawWindow(ctx, size / 2 - fr * 0.32, size / 2 + fr * 0.12, fr * 0.64, fr * 0.2);
  }
  protected override paintBeforeNeedle(ctx: Ctx2D, _size: number, fr: number, r: InstrumentReadings): void {
    drawText(ctx, hourLabels.get(r.tachHours), 0, fr * 0.22, gaugeFont(fr * 0.15), GAUGE_COLORS.white);
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
  constructor(side: 'left' | 'right', factory?: CanvasFactory, maxGal: number = FUEL.maxGal) {
    super({
      min: 0, max: maxGal, ...SMALL, redlines: [0],
      majorStep: maxGal / 2, minorStep: maxGal / 4, labelStep: maxGal / 2,
      labelFormat: (v) => (v <= 0 ? 'E' : v >= maxGal - 1e-6 ? 'F' : '½'),
      title: side === 'left' ? 'LEFT' : 'RIGHT', subtitle: 'FUEL QTY', unit: 'GAL',
    }, side === 'left' ? (r) => r.fuelGal[0] : (r) => r.fuelGal[1], factory);
  }
}

export class OilTemperatureGauge extends ArcGauge {
  constructor(factory?: CanvasFactory, t: Readonly<OilTempMarkings> = OIL_TEMP) {
    super({
      min: t.min, max: t.max, ...SMALL, bands: [{ from: t.greenLo, to: t.greenHi, color: GAUGE_COLORS.green }], redlines: [t.redline],
      majorStep: 25, minorStep: 25, labelStep: 50, tickMin: 75, labelMin: 100, title: 'OIL TEMP', unit: '°F',
    }, (r) => r.engine.oilTempF, factory);
  }
}

export class OilPressureGauge extends ArcGauge {
  constructor(factory?: CanvasFactory, p: Readonly<OilPressMarkings> = OIL_PRESS) {
    super({
      min: p.min, max: p.max, ...SMALL,
      bands: [{ from: p.greenLo, to: p.greenHi, color: GAUGE_COLORS.green }, ...(p.yellow ?? []).map(([from, to]) => ({ from, to, color: GAUGE_COLORS.yellow }))],
      redlines: [p.redLo, p.redHi],
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
  constructor(factory?: CanvasFactory, maxA: number = AMMETER.max) {
    super({
      min: -maxA, max: maxA, ...SMALL, majorStep: maxA / 2, minorStep: maxA / 6, labelStep: maxA / 2,
      labelFormat: (v) => String(Math.abs(v)), title: 'AMPS', unit: 'D          C',
    }, (r) => r.ampsA, factory);
  }
}

/** Bus voltmeter: red below the LOW VOLTS threshold, green over the charging range (14 V or 28 V scale). */
export class Voltmeter extends ArcGauge {
  constructor(factory?: CanvasFactory, e: Pick<ElectricalMarkings, 'voltmeter' | 'lowVoltsV' | 'nominalV'> = { voltmeter: { min: 16, max: 32, greenLo: 26, greenHi: 29.6 }, lowVoltsV: 24.5, nominalV: 28 }) {
    const v = e.voltmeter, k = e.nominalV / 14;
    super({
      min: v.min, max: v.max, ...SMALL,
      bands: [{ from: v.min, to: Math.min(e.lowVoltsV, v.max), color: GAUGE_COLORS.red }, { from: v.greenLo, to: v.greenHi, color: GAUGE_COLORS.green }],
      majorStep: 2 * k, minorStep: k, labelStep: 4 * k, title: 'VOLTS',
    }, (r) => r.voltsV, factory);
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
