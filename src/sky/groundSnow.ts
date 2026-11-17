/**
 * Ground snow cover from the weather: a snow line (metres MSL, below which the ground is bare) and an
 * amount (0 bare … 1 fully white above the line). Pure, so the terrain shader and the scenery get the
 * same answer and tests can pin it.
 *
 * 'auto' follows the surface temperature: lying snow survives where the air stays near freezing, so
 * the line sits where the standard lapse rate (6.5 K/km) cools the sea-level temperature to about
 * −1 °C. A sea-level 18 °C summer day puts it near 2900 m (only high peaks white), 5 °C near 920 m,
 * and anything at or below −1 °C whitens the ground at sea level. Falling snow brings the line down
 * to the surface. 'none' and 'full' override it.
 */
import type { WeatherState } from '../core/types';

export type GroundSnowMode = 'auto' | 'none' | 'full';

export interface GroundSnow { lineM: number; amount: number }

const LAPSE_K_PER_M = 0.0065;
/** air temperature (°C) at which lying snow is assumed to survive */
const LYING_SNOW_C = -1;

export function groundSnowFor(w: Pick<WeatherState, 'temperatureC' | 'precipitationType' | 'precipitationRate'>, mode: GroundSnowMode): GroundSnow {
  if (mode === 'none') return { lineM: 9000, amount: 0 };
  if (mode === 'full') return { lineM: -500, amount: 1 };
  const t = Number.isFinite(w.temperatureC) ? w.temperatureC : 15;
  let lineM = (t - LYING_SNOW_C) / LAPSE_K_PER_M;
  if (w.precipitationType === 'snow' && w.precipitationRate > 0) lineM = Math.min(lineM, -500);
  lineM = Math.max(-500, Math.min(9000, lineM));
  return { lineM, amount: lineM >= 9000 ? 0 : 1 };
}

/** Snow cover at one altitude (the shader's mean, without its noise): 0 below the line, 1 above it. */
export function snowAt(s: GroundSnow, altM: number): number {
  const x = Math.max(0, Math.min(1, (altM - (s.lineM - 150)) / 300));
  return s.amount * x * x * (3 - 2 * x);
}

/**
 * Eases toward a target so a weather change does not repaint the ground in one frame: the line moves
 * at up to `lineRateMps`, the amount at `amountRate` per second. `snap` jumps (a new flight).
 */
export class GroundSnowState implements GroundSnow {
  lineM = 9000;
  amount = 0;
  constructor(private readonly lineRateMps = 40, private readonly amountRate = 1 / 30) {}
  update(target: GroundSnow, dtS: number, snap = false): this {
    if (snap || !(dtS >= 0)) { this.lineM = target.lineM; this.amount = target.amount; return this; }
    const dl = target.lineM - this.lineM, da = target.amount - this.amount;
    this.lineM += Math.sign(dl) * Math.min(Math.abs(dl), this.lineRateMps * dtS);
    this.amount += Math.sign(da) * Math.min(Math.abs(da), this.amountRate * dtS);
    return this;
  }
}
