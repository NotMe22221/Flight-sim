/**
 * Airspeed indicator. C172S (default): non-linear dial (dead sector below 40 kt), white arc 40–85
 * (inner), green 48–129, yellow 129–163, red line at Vne 163, Va placard. Other aircraft pass their
 * V-speeds, dial geometry (`AsiDial`) and placard (`PanelSpec`).
 */
import type { CanvasFactory, Ctx2D } from '../canvas';
import { ASI_DIAL, C172S_VSPEEDS, type VSpeeds } from '../c172';
import type { AsiDial } from '../panelSpec';
import { asiNeedleDeg, asiNeedleOnDial } from '../scales';
import { ArcGauge } from './ArcGauge';
import { GAUGE_COLORS, drawText, gaugeFont } from './common';

export class AirspeedIndicator extends ArcGauge {
  constructor(public readonly vspeeds: VSpeeds = C172S_VSPEEDS, factory?: CanvasFactory, readonly dial: Readonly<AsiDial> = ASI_DIAL, private readonly placard = `Va ${vspeeds.va} KIAS @ 2550 LB`) {
    super({
      min: dial.minKt, max: dial.maxKt, startDeg: dial.zeroDeg, sweepDeg: dial.kneeDeg + dial.sweepDeg,
      bands: [
        { from: vspeeds.vs1, to: vspeeds.vno, color: GAUGE_COLORS.green },
        { from: vspeeds.vno, to: vspeeds.vne, color: GAUGE_COLORS.yellow },
        { from: vspeeds.vso, to: vspeeds.vfe, color: GAUGE_COLORS.white, radiusFrac: 0.76 },
      ],
      redlines: [vspeeds.vne],
      majorStep: 10, minorStep: 5, labelStep: 20, tickMin: dial.kneeKt, labelMin: dial.kneeKt,
      title: 'AIRSPEED', unit: 'KNOTS', angleOf: dial === ASI_DIAL ? asiNeedleDeg : (v) => asiNeedleOnDial(dial, v), labelFrac: 0.6,
    }, (r) => r.iasKt, factory);
  }

  protected override paintExtraStatic(ctx: Ctx2D, size: number, fr: number): void {
    const cx = size / 2, cy = size / 2;
    if (this.placard) drawText(ctx, this.placard, cx, cy + fr * 0.6, gaugeFont(fr * 0.085), GAUGE_COLORS.grey);
  }
}
