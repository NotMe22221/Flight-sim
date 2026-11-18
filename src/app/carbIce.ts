/**
 * Carburettor ice for carburetted piston engines (the Super Cub's O-320; the fuel-injected 172S has
 * none). Ice forms in the venturi when moist air is cooled by fuel evaporation and the pressure drop:
 * after the FAA carburettor-icing chart (AC 20-113 / SAIB CE-09-35), risk is greatest from about
 * 0 °C to 15 °C at high humidity and extends to about −10 °C and 30 °C; it is worse at low (glide)
 * power, where the part-closed throttle valve adds cooling and a place for ice to grow.
 *
 * Ice is modelled as a restriction of the induction: it scales the effective throttle opening, so
 * rpm (or manifold pressure) falls slowly at a fixed throttle, the classic symptom. Heavy ice runs
 * rough, then stops the engine. Carb heat (hot unfiltered air from the exhaust shroud) melts it in
 * well under a minute while the engine is hot and costs about 10 % power (the rpm drop of the
 * run-up check).
 */

export interface CarbIceInput {
  /** outside air temperature, °C */
  oatC: number;
  /** relative humidity 0…1 */
  humidity: number;
  /** in cloud or precipitation */
  visibleMoisture: boolean;
  /** pilot throttle 0…1 */
  throttle: number;
  carbHeat: boolean;
  /** engine rpm (a stopped engine neither ices nor heats) */
  rpm: number;
  /** failures panel "carburettor ice": icing conditions regardless of the weather */
  forced?: boolean;
}

/** worst-case accretion: fully iced in about 5 minutes at glide power */
const MAX_RATE = 1 / 300;
/** with carb heat and a hot engine: clear in about 40 s */
const MELT_RATE = 1 / 40;
const STOP_AT = 0.92;
const RESTART_BELOW = 0.6;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (e0: number, e1: number, x: number) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/** Icing risk 0…1 for the conditions (the chart's bands, smoothed). */
export function carbIceRisk(oatC: number, humidity: number, visibleMoisture: boolean): number {
  if (!Number.isFinite(oatC)) return 0;
  const tBand = smooth(-12, -2, oatC) * (1 - smooth(16, 32, oatC));
  const h = visibleMoisture ? 1 : smooth(0.45, 0.9, Number.isFinite(humidity) ? humidity : 0);
  return tBand * h;
}

export class CarbIce {
  /** 0 clear … 1 fully blocked */
  ice = 0;
  /** true while heavy ice has stopped the engine */
  starved = false;
  private t = 0;

  reset(): void { this.ice = 0; this.starved = false; }

  update(dtS: number, i: CarbIceInput): void {
    if (!(dtS > 0)) return;
    this.t += dtS;
    const running = i.rpm > 300;
    if (i.carbHeat && running) {
      // exhaust heat: more at higher rpm
      this.ice -= MELT_RATE * (0.5 + 0.5 * clamp01(i.rpm / 2300)) * dtS;
    } else if (running) {
      const risk = i.forced ? 1 : carbIceRisk(i.oatC, i.humidity, i.visibleMoisture);
      const power = 1 - 0.5 * clamp01((clamp01(i.throttle) - 0.3) / 0.6); // glide 1 … full 0.5
      this.ice += MAX_RATE * risk * power * dtS;
    } else if (!i.forced) {
      // a stopped engine: the carburettor slowly warms from the engine compartment
      this.ice -= (MELT_RATE / 10) * dtS;
    }
    this.ice = clamp01(this.ice);
    if (this.ice > STOP_AT) this.starved = true;
    else if (this.ice < RESTART_BELOW) this.starved = false;
  }

  /**
   * Effective throttle for a pilot throttle: the ice restriction (with a rough-running wobble once
   * it is heavy) and the carb-heat loss.
   */
  throttle(pilot: number, carbHeat: boolean): number {
    const restriction = 1 - 0.8 * this.ice ** 1.5;
    const rough = this.ice > 0.35 ? 1 - 0.06 * (this.ice - 0.35) * (1 + Math.sin(this.t * 23) * Math.sin(this.t * 7.1)) : 1;
    return clamp01(pilot * restriction * rough * (carbHeat ? 0.9 : 1));
  }
}
