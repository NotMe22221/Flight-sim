/**
 * Cessna 172S (Lycoming IO-360-L2A, 180 hp, 2 550 lb) instrument constants. Sources: POH Section 2
 * markings as summarised in docs/research/05 §1.1 and §1.3. Values are tunable but should match the
 * `AircraftConfig.limits` of the aircraft actually loaded; `SteamPanel`/`G1000` accept overrides.
 */

/** V-speeds in KIAS used for airspeed indicator arcs and G1000 bugs. */
export interface VSpeeds {
  vso: number; vs1: number; vfe: number; vfe10: number; vno: number; vne: number;
  vr: number; vx: number; vy: number; vglide: number; va: number;
}

export const C172S_VSPEEDS: Readonly<VSpeeds> = Object.freeze({
  vso: 40, vs1: 48, vfe: 85, vfe10: 110, vno: 129, vne: 163,
  vr: 55, vx: 62, vy: 74, vglide: 68, va: 105,
});

/** Airspeed dial geometry: dead sector 0–40 kt over 20°, then linear 40–200 kt over 320°. */
export const ASI_DIAL = Object.freeze({ minKt: 0, kneeKt: 40, maxKt: 200, kneeDeg: 20, sweepDeg: 320, zeroDeg: -10 });

/** Tachometer markings (RPM). */
export const TACH = Object.freeze({ min: 0, max: 3500, greenLo: 2100, greenHi: 2700, redline: 2700, sweepDeg: 270 });
/** Oil temperature gauge (°F). */
export const OIL_TEMP = Object.freeze({ min: 75, max: 250, greenLo: 100, greenHi: 245, redline: 245 });
/** Oil pressure gauge (psi). */
export const OIL_PRESS = Object.freeze({ min: 0, max: 115, redLo: 20, greenLo: 50, greenHi: 90, redHi: 115 });
/** Fuel quantity per tank (US gal, usable shown; total capacity 26.5, unusable 1.5). */
export const FUEL = Object.freeze({ maxGal: 26, usableGal: 25, unusableGalPerTank: 1.5, lowGal: 5, lowHoldS: 60, kgPerGal: 2.725 });
/** Fuel flow (gph). */
export const FUEL_FLOW = Object.freeze({ min: 0, max: 20, greenLo: 0, greenHi: 16 });
/** Manifold pressure (inHg) — 182-class archetype, unused on the 172S fixed-pitch panel. */
export const MAP = Object.freeze({ min: 10, max: 35, greenLo: 15, greenHi: 30 });
/** EGT (°F) with 25 °F divisions. */
export const EGT = Object.freeze({ min: 1000, max: 1700, divF: 25 });
/** Suction (inHg). */
export const SUCTION = Object.freeze({ min: 3, max: 7, greenLo: 4.5, greenHi: 5.5, lowWarn: 3.5 });
/** Ammeter (A). 172S shows alternator load 0–60 A; we draw −60…+60 centred. */
export const AMMETER = Object.freeze({ min: -60, max: 60 });
/** Electrical bus. */
export const ELECTRICAL = Object.freeze({ busV: 28, batteryV: 24.2, lowVoltsV: 24.5, alternatorMinRpm: 800 });
/** Flap detents in degrees. */
export const FLAP_DETENTS: readonly number[] = Object.freeze([0, 10, 20, 30]);
/** OAT gauge (°C). */
export const OAT = Object.freeze({ min: -40, max: 50 });
