/**
 * Piper PA-18-150 Super Cub panel ('cub-steam'): instrument markings and the 1024×512 layout.
 *
 * A Super Cub has no gyro horizon or directional gyro: airspeed and altimeter, an electric turn
 * coordinator and a VSI, a large tachometer under the wet compass, oil temperature and pressure,
 * a voltmeter for the 14 V system, fuel gauges, the magneto key, master and radio switches,
 * primer and carburettor heat, and one NAV/COM with a transponder (for ATC).
 *
 * Markings: PA-18-150 owner's handbook, instrument markings (facts) — tachometer green 500–2,700
 * rpm, red line 2,700; oil temperature green 75–245 °F, red line 245; oil pressure green 60–90 psi,
 * yellow 25–60 (idle) and 90–100 (warm-up), red lines 25 and 100 (Lycoming O-320-A operator's
 * manual). The airspeed arcs come from the flight model's limits (`AircraftConfig.limits`).
 */
import type { AircraftConfig } from '../core/types';
import { LB } from '../core/units';
import { electricalMarkings, fuelMarkings, type AsiDial, type OilPressMarkings, type OilTempMarkings, type PanelSpec, type TachMarkings, vspeedsFromLimits } from './panelSpec';
import type { PanelLayout } from './SteamPanel';

/** Super Cub airspeed dial: 0–20 kt dead sector, 20–140 kt over 320° (2.7°/kt, more spread than the 172's). */
export const CUB_ASI_DIAL: Readonly<AsiDial> = Object.freeze({ minKt: 0, kneeKt: 20, maxKt: 140, kneeDeg: 20, sweepDeg: 320, zeroDeg: -10 });
/** Tachometer (rpm): green 500–2,700, red line 2,700 (fixed-pitch O-320). */
export const CUB_TACH: Readonly<TachMarkings> = Object.freeze({ min: 0, max: 3500, greenLo: 500, greenHi: 2700, redline: 2700, sweepDeg: 270 });
/** Oil temperature (°F): green 75–245, red line 245. */
export const CUB_OIL_TEMP: Readonly<OilTempMarkings> = Object.freeze({ min: 75, max: 250, greenLo: 75, greenHi: 245, redline: 245 });
/** Oil pressure (psi): red 25 (minimum idling) and 100 (maximum), green 60–90, yellow idle / warm-up arcs. */
export const CUB_OIL_PRESS: Readonly<OilPressMarkings> = Object.freeze({
  min: 0, max: 120, redLo: 25, greenLo: 60, greenHi: 90, redHi: 100, yellow: Object.freeze([Object.freeze([25, 60] as const), Object.freeze([90, 100] as const)]),
});
/** A wing tank gauge below 3 gal for a minute lights LOW FUEL (there is no annunciator panel; the HUD shows it). */
export const CUB_LOW_FUEL_GAL = 3;

/** The Super Cub panel spec for a configuration (V-speeds, fuel and bus from the flight model's config). */
export function cubPanelSpec(cfg: AircraftConfig): PanelSpec {
  const vspeeds = vspeedsFromLimits(cfg.limits);
  const lb = Math.round(cfg.mass.maxTakeoffKg / LB / 10) * 10;
  const red = cfg.limits.redlineRPM || CUB_TACH.redline;
  return {
    panel: 'cub-steam',
    nameplate: 'PIPER SUPER CUB',
    vspeeds,
    asiDial: CUB_ASI_DIAL,
    asiPlacard: `Va ${Math.round(vspeeds.va)} KIAS @ ${lb.toLocaleString('en-US')} LB`,
    tach: { ...CUB_TACH, greenHi: Math.min(CUB_TACH.greenHi, red), redline: red },
    oilTemp: CUB_OIL_TEMP,
    oilPress: CUB_OIL_PRESS,
    fuel: fuelMarkings(cfg, CUB_LOW_FUEL_GAL),
    electrical: electricalMarkings(cfg),
    flapDetents: [...cfg.controls.flaps.detentsDeg],
    autopilot: false,
  };
}

/**
 * Super Cub arrangement for the 1024×512 texture (the cockpit mesh is 0.60 × 0.30 m): airspeed and
 * altimeter top left over the turn coordinator and VSI, the wet compass above a large tachometer in
 * the middle with the warning lights under it, NAV/COM and transponder top right over the engine
 * and fuel gauges, voltmeter and clock; magneto key, master/radio switches, primer and carb heat
 * along the bottom edge. The middle of the bottom edge is left clear (the stick sits in front of it).
 */
export const CUB_STEAM_LAYOUT: PanelLayout = {
  width: 1024, height: 512, background: '#33302b',
  nameplate: { text: 'PIPER  SUPER CUB', x: 520, y: 470, px: 15 },
  items: [
    { id: 'asi', x: 20, y: 20, size: 190 }, { id: 'alt', x: 222, y: 20, size: 190 },
    { id: 'tc', x: 40, y: 226, size: 150 }, { id: 'vsi', x: 242, y: 226, size: 150 },
    { id: 'compass', x: 432, y: 8, size: 180 },
    { id: 'tach', x: 432, y: 94, size: 180 },
    { id: 'warn', x: 432, y: 288, size: 180 },
    { id: 'navcom', x: 624, y: 20, size: 380 },
    { id: 'xpdr', x: 624, y: 134, size: 380 },
    { id: 'fuelL', x: 624, y: 210, size: 92 }, { id: 'fuelR', x: 720, y: 210, size: 92 },
    { id: 'oilT', x: 816, y: 210, size: 92 }, { id: 'oilP', x: 912, y: 210, size: 92 },
    { id: 'volts', x: 624, y: 312, size: 92 }, { id: 'clock', x: 744, y: 314, size: 180 },
    { id: 'mags', x: 36, y: 398, size: 100 }, { id: 'master', x: 152, y: 398, size: 100 },
    { id: 'primer', x: 270, y: 410, size: 76 }, { id: 'carbHeat', x: 358, y: 410, size: 76 },
  ],
};
