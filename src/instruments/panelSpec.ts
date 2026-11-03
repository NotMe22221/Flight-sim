/**
 * Per-aircraft instrument markings and system constants for the steam panels: V-speed arcs, dial
 * geometry, engine-gauge markings, fuel senders and the electrical bus the gauges are powered from.
 * The C172S values are exactly the historical constants in `c172.ts`; other aircraft derive theirs
 * from their `AircraftConfig` (`panelSpecFor`), so the airspeed arcs always match the flight model's
 * limits and the bus thresholds scale with the aircraft's nominal voltage.
 */
import type { AircraftConfig } from '../core/types';
import { AVGAS_KG_PER_GAL } from '../core/units';
import { AMMETER, ASI_DIAL, C172S_VSPEEDS, ELECTRICAL, FLAP_DETENTS, FUEL, OIL_PRESS, OIL_TEMP, TACH, type VSpeeds } from './c172';
import { defaultInstrumentConfig, type InstrumentConfig } from './readings';

/** Airspeed dial: dead sector `minKt`–`kneeKt` over `kneeDeg`, then linear to `maxKt` over `sweepDeg`. */
export interface AsiDial { minKt: number; kneeKt: number; maxKt: number; kneeDeg: number; sweepDeg: number; zeroDeg: number }
export interface TachMarkings { min: number; max: number; greenLo: number; greenHi: number; redline: number; sweepDeg: number }
export interface OilTempMarkings { min: number; max: number; greenLo: number; greenHi: number; redline: number }
export interface OilPressMarkings {
  min: number; max: number; redLo: number; greenLo: number; greenHi: number; redHi: number;
  /** caution (yellow) arcs, e.g. idle and ground warm-up on Lycoming installations */
  yellow?: readonly (readonly [number, number])[];
}
export interface FuelMarkings {
  /** full-scale reading of one tank gauge, US gal */ maxGal: number;
  /** usable fuel per tank, US gal */ usableGal: number;
  unusableGalPerTank: number;
  /** a tank gauge below this for `lowHoldS` lights LOW FUEL */ lowGal: number; lowHoldS: number;
  kgPerGal: number;
}
export interface ElectricalMarkings {
  /** regulated bus voltage, V */ busV: number;
  /** resting battery voltage, V */ batteryV: number;
  /** LOW VOLTS threshold, V */ lowVoltsV: number;
  alternatorMinRpm: number;
  /** bus voltage above which electric instruments run (fallback bus model, when the FDM has none) */ busLiveV: number;
  /** ammeter full scale, A (centre-zero ±) */ ammeterMaxA: number;
  /** voltmeter scale and green arc, V */ voltmeter: { min: number; max: number; greenLo: number; greenHi: number };
  /** nominal system voltage (14 or 28) */ nominalV: number;
}

export interface PanelSpec {
  /** AircraftConfig.panel this spec was built for */
  panel: AircraftConfig['panel'];
  /** maker / model plate text */
  nameplate: string;
  vspeeds: VSpeeds;
  asiDial: AsiDial;
  /** placard on the airspeed dial (e.g. the manoeuvring speed); '' for none */
  asiPlacard: string;
  /** operating-limitations placard on the panel, under the nameplate (optional; '\n' separates lines) */
  panelPlacard?: string;
  tach: TachMarkings;
  oilTemp: OilTempMarkings;
  oilPress: OilPressMarkings;
  fuel: FuelMarkings;
  electrical: ElectricalMarkings;
  flapDetents: readonly number[];
  /** the aircraft has an autopilot (AP keys, AP annunciations, the KAP 140-style unit) */
  autopilot: boolean;
}

/** Voltmeter scale for a nominal 14 V or 28 V system (8–16 V / 16–32 V, green ≈ 93–106 % of nominal). */
export function voltmeterScale(nominalV: number): ElectricalMarkings['voltmeter'] {
  const k = nominalV / 14;
  return { min: 8 * k, max: 16 * k, greenLo: 13 * k, greenHi: 14.8 * k };
}

/** The Cessna 172S (28 V) panel: the historical constants of `c172.ts`. */
export const C172S_PANEL_SPEC: Readonly<PanelSpec> = Object.freeze({
  panel: 'c172-steam' as const,
  nameplate: 'CESSNA 172S',
  vspeeds: C172S_VSPEEDS,
  asiDial: ASI_DIAL,
  asiPlacard: `Va ${C172S_VSPEEDS.va} KIAS @ 2550 LB`,
  tach: TACH,
  oilTemp: OIL_TEMP,
  oilPress: OIL_PRESS,
  fuel: FUEL,
  electrical: Object.freeze({
    busV: ELECTRICAL.busV, batteryV: ELECTRICAL.batteryV, lowVoltsV: ELECTRICAL.lowVoltsV, alternatorMinRpm: ELECTRICAL.alternatorMinRpm,
    busLiveV: 20, ammeterMaxA: AMMETER.max, voltmeter: voltmeterScale(28), nominalV: 28,
  }),
  flapDetents: FLAP_DETENTS,
  autopilot: true,
});

/** V-speeds (KIAS) from the flight model's limits: the arcs of the airspeed indicator. */
export function vspeedsFromLimits(l: AircraftConfig['limits']): VSpeeds {
  const vfe = l.VfeKt.length ? l.VfeKt[l.VfeKt.length - 1] : l.VsoKt;
  return {
    vso: l.VsoKt, vs1: l.Vs1Kt, vfe, vfe10: l.VfeKt[0] ?? vfe, vno: l.VnoKt, vne: l.VneKt,
    vr: l.VrKt, vx: l.VxKt, vy: l.VyKt, vglide: l.VgKt, va: l.VaKt,
  };
}

/** Nominal system voltage from an electrical spec: 14 V for a 12 V battery, 28 V otherwise. */
export function nominalVolts(cfg: AircraftConfig): number {
  const e = cfg.electrical;
  if (!e) return 28;
  if (e.batteryNominalV !== undefined) return e.batteryNominalV <= 14 ? 14 : 28;
  return e.regulatorV < 20 ? 14 : 28;
}

/** Electrical markings for a configuration (scaled from the C172S 28 V values when the FDM gives none). */
export function electricalMarkings(cfg: AircraftConfig): ElectricalMarkings {
  const nominal = nominalVolts(cfg);
  const k = nominal / 28;
  const e = cfg.electrical;
  return {
    busV: e ? e.regulatorV : ELECTRICAL.busV * k,
    batteryV: (e?.batteryNominalV ?? 24 * k) * (ELECTRICAL.batteryV / 24),
    lowVoltsV: e ? e.lowVoltsV : ELECTRICAL.lowVoltsV * k,
    alternatorMinRpm: e ? e.alternatorCutInRpm : ELECTRICAL.alternatorMinRpm,
    busLiveV: e ? e.dropOutV : 20 * k,
    ammeterMaxA: e ? Math.max(20, Math.round(e.alternatorMaxA / 10) * 10) : AMMETER.max,
    voltmeter: voltmeterScale(nominal),
    nominalV: nominal,
  };
}

/** Fuel sender markings from the configuration's tanks (the first tank stands for each side). */
export function fuelMarkings(cfg: AircraftConfig, lowGal: number, lowHoldS = FUEL.lowHoldS): FuelMarkings {
  const t = cfg.mass.tanks[0];
  if (!t) return { ...FUEL, lowGal, lowHoldS };
  const capGal = t.capacityKg / AVGAS_KG_PER_GAL, usableGal = t.usableKg / AVGAS_KG_PER_GAL;
  return {
    maxGal: Math.round(capGal), usableGal, unusableGalPerTank: Math.max(0, capGal - usableGal),
    lowGal, lowHoldS, kgPerGal: AVGAS_KG_PER_GAL,
  };
}

/**
 * Instrument-model settings for a panel: fuel senders, LOW FUEL / OIL PRESS thresholds and the
 * fallback bus. `instrumentConfigFor(C172S_PANEL_SPEC)` equals `defaultInstrumentConfig()`.
 */
export function instrumentConfigFor(spec: Readonly<PanelSpec>): InstrumentConfig {
  const e = spec.electrical;
  return {
    ...defaultInstrumentConfig(),
    lowFuelGal: spec.fuel.lowGal, lowFuelHoldS: spec.fuel.lowHoldS,
    fuelTankMaxGal: spec.fuel.maxGal, fuelUnusableGalPerTank: spec.fuel.unusableGalPerTank, fuelKgPerGal: spec.fuel.kgPerGal,
    oilPressLowPsi: spec.oilPress.redLo,
    bus: { busV: e.busV, batteryV: e.batteryV, lowVoltsV: e.lowVoltsV, alternatorMinRpm: e.alternatorMinRpm, ammeterMaxA: e.ammeterMaxA, busLiveV: e.busLiveV },
  };
}
